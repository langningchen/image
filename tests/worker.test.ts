import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker/index.ts';
import { recordAccess, initializeAccess, getAccessTime, listAccessTimes } from '../src/worker/repositories/access.ts';
import { cleanupInactiveImages } from '../src/worker/services/cleanup.ts';
import { RETENTION_MS } from '../src/worker/constants.ts';

const id = 'a'.repeat(32);
const second = 'b'.repeat(32);
function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_image_access.sql', import.meta.url), 'utf8'));
    function prepare(sql: string, args: unknown[] = []) {
        return {
            bind: (...values: unknown[]) => prepare(sql, values),
            run: async () => sqlite.prepare(sql).run(...args),
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        };
    }
    const env = { DB: { prepare, batch: async (statements: any[]) => Promise.all(statements.map(s => s.run())) }, GithubOwner: 'test', GithubRepo: 'images', GithubPAT: 'test' };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    return { env, ctx, pending, sqlite };
}

test('D1 upserts and reconciliation never overwrite newer access; timestamps paginate', async () => {
    const { env } = fixture();
    await recordAccess(env, id, 200);
    await recordAccess(env, id, 100);
    await initializeAccess(env, [id, second], 150);
    assert.equal(await getAccessTime(env, id), 200);
    assert.equal(await getAccessTime(env, second), 150);
    assert.equal(await getAccessTime(env, 'c'.repeat(32)), null);
    for (let i = 0; i < 1005; i++) {
        let n = i;
        let key = '';
        for (let j = 0; j < 4; j++) { key += String.fromCharCode(97 + n % 26); n = Math.floor(n / 26); }
        await recordAccess(env, 'z'.repeat(28) + key, i);
    }
    assert.equal((await listAccessTimes(env)).size, 1007);
});

test('routing rejects invalid paths and supports preflight without GitHub', async () => {
    const { env, ctx } = fixture();
    assert.equal((await worker.fetch(new Request('https://image.test/no-image'), env, ctx)).status, 404);
    const response = await worker.fetch(new Request('https://image.test/upload', { method: 'OPTIONS' }), env, ctx);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('upload initializes D1, previews do not renew and conditional views do renew', async t => {
    const { env, ctx, pending } = fixture();
    let uploaded = '';
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (init?.method === 'PUT') {
            uploaded = new URL(url).pathname.split('/').at(-1).slice(0, -5);
            return Response.json({ content: { name: `${uploaded}.jpeg` } });
        }
        return new Response('image bytes');
    });
    const response = await worker.fetch(new Request('https://image.test/upload', { method: 'POST', body: 'data:image/jpeg;base64,aGVsbG8=' }), env, ctx);
    assert.match(await response.text(), /^[a-z]{32}$/);
    assert.equal(uploaded.length, 32);
    assert.ok(await getAccessTime(env, uploaded));
    await recordAccess(env, id, 1);
    await worker.fetch(new Request(`https://image.test/${id}?search`), env, ctx);
    assert.equal(pending.length, 0);
    assert.equal(await getAccessTime(env, id), 1);
    const cached = await worker.fetch(new Request(`https://image.test/${id}`, { headers: { 'If-None-Match': `"${id}"` } }), env, ctx);
    assert.equal(cached.status, 304);
    await Promise.all(pending);
    assert.ok((await getAccessTime(env, id)) > 1);
});

test('conditional requests return 404 when image was deleted', async t => {
    const { env, ctx } = fixture();
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
    assert.equal((await worker.fetch(new Request(`https://image.test/${id}`, { headers: { 'If-None-Match': `"${id}"` } }), env, ctx)).status, 404);
});

test('cleanup deletes inactive files, grants missing images grace and removes orphans', async t => {
    const { env } = fixture();
    const now = RETENTION_MS * 2;
    const orphan = 'c'.repeat(32);
    await recordAccess(env, id, 1);
    await recordAccess(env, orphan, 1);
    const deleted: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).includes('/git/trees/')) return Response.json({ tree: [id, second].map(image => ({ path: `${image}.jpeg`, type: 'blob' })) });
        if (init?.method === 'DELETE') { deleted.push(String(url)); return Response.json({}); }
        return Response.json({ sha: 'sha' });
    });
    await cleanupInactiveImages(env, now);
    assert.equal(deleted.length, 1);
    assert.equal(await getAccessTime(env, id), null);
    assert.equal(await getAccessTime(env, second), now);
    assert.equal(await getAccessTime(env, orphan), null);
});

test('cleanup fails closed on truncated GitHub trees', async t => {
    const { env } = fixture();
    await recordAccess(env, id, 1);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ truncated: true }));
    await assert.rejects(cleanupInactiveImages(env, RETENTION_MS * 2), /truncated/);
    assert.equal(await getAccessTime(env, id), 1);
});

test('cleanup preserves metadata when GitHub deletion fails', async t => {
    const { env } = fixture();
    await recordAccess(env, id, 1);
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).includes('/git/trees/')) return Response.json({ tree: [{ path: `${id}.jpeg`, type: 'blob' }] });
        if (init?.method === 'DELETE') return new Response('Conflict', { status: 409 });
        return Response.json({ sha: 'sha' });
    });
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(await getAccessTime(env, id), 1);
});

test('cleanup rechecks access renewed after its initial snapshot', async t => {
    const { env } = fixture();
    const now = RETENTION_MS * 2;
    await recordAccess(env, id, 1);
    const originalPrepare = env.DB.prepare;
    env.DB.prepare = (sql, args = []) => {
        const statement = originalPrepare(sql, args);
        if (sql.includes('ORDER BY image_id')) {
            const all = statement.all;
            statement.all = async () => {
                const snapshot = await all();
                await recordAccess(env, id, now);
                return snapshot;
            };
        }
        // The real query is executed after bind().
        const bind = statement.bind;
        statement.bind = (...values) => {
            const bound = bind(...values);
            if (sql.includes('ORDER BY image_id')) {
                const all = bound.all;
                bound.all = async () => {
                    const snapshot = await all();
                    await recordAccess(env, id, now);
                    return snapshot;
                };
            }
            return bound;
        };
        return statement;
    };
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return Response.json({ tree: [{ path: `${id}.jpeg`, type: 'blob' }] });
    });
    await cleanupInactiveImages(env, now);
    assert.equal(calls, 1);
    assert.equal(await getAccessTime(env, id), now);
});
