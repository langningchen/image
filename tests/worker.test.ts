import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repositoryConfigFiles } from '../src/worker/repository-config.generated.ts';
import worker from '../src/worker/index.ts';
import { recordAccess, initializeAccess, getAccessTime, listAccessTimes } from '../src/worker/repositories/access.ts';
import { cleanupInactiveImages } from '../src/worker/services/cleanup.ts';
import { recordViolation, getIpControl, updateIpControl, normalizeIp, VIOLATION_WINDOW_MS } from '../src/worker/repositories/ip-controls.ts';
import { setLocked, claimDeletion, releaseDeletion, getRetentionDistribution, listImages, saveUploadedImage } from '../src/worker/repositories/management.ts';
import { getTrafficStats, recordTraffic, pruneActivity, listIpOverview, requestLocation } from '../src/worker/repositories/traffic.ts';
import { RETENTION_MS } from '../src/worker/constants.ts';
import { CONSENT_HEADER, TERMS_VERSION } from '../src/terms.ts';
import { setFallback, getFallback } from '../src/worker/repositories/assessment.ts';
import { parseVerdict, AssessmentError, moderateImage } from '../src/worker/services/moderation.ts';
import { getUploadLimits, setUploadLimits } from '../src/worker/repositories/upload-settings.ts';
import { DEFAULT_UPLOAD_LIMITS } from '../src/uploadLimits.ts';

const id = 'a1'.repeat(16);
const second = 'b2'.repeat(16);
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const ONE_PIXEL_WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7+4AAAAA==';
const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG}`;
function fixture(alphanumericIds = true) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_image_access.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0002_image_management.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0003_upload_controls_and_traffic.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0004_ip_geolocation.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0005_moderation_fallback.sql', import.meta.url), 'utf8'));
    if (alphanumericIds) sqlite.exec(readFileSync(new URL('../migrations/0006_alphanumeric_image_ids.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0007_upload_limits.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0008_traffic_ip_index.sql', import.meta.url), 'utf8'));
    function prepare(sql: string, args: unknown[] = []) {
        return {
            bind: (...values: unknown[]) => prepare(sql, values),
            run: async () => {
                if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: sqlite.prepare(sql).all(...args), meta: { changes: 0 } };
                if (sql.includes('RETURNING')) {
                    const results = sqlite.prepare(sql).all(...args);
                    return { results, meta: { changes: results.length } };
                }
                const result = sqlite.prepare(sql).run(...args);
                return { results: [], meta: { changes: Number(result.changes) } };
            },
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        };
    }
    const env = { DB: { prepare, batch: async (statements: any[]) => Promise.all(statements.map(s => s.run())) }, GITHUB_OWNER: 'test', GITHUB_REPO: 'images', GITHUB_PAT: 'test', ADMIN_PASSWORD: 'test-password', AI: { run: async () => ({ response: JSON.stringify({ approved: true, reason: 'safe' }) }) } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    return { env, ctx, pending, sqlite };
}

function mockCleanupGithub(t: TestContext, paths: string[], options: { fail?: boolean; conflicts?: number; entries?: { path: string; type: string; sha?: string; mode?: string }[]; truncated?: boolean } = {}) {
    const trees: any[] = [];
    const commits: any[] = [];
    const updates: any[] = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const path = new URL(url).pathname.replace('/repos/test/images', '');
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (path === '') return Response.json({ default_branch: 'main' });
        if (path === '/git/ref/heads/main') return Response.json({ object: { sha: `head-${updates.length}` } });
        if (path.startsWith('/git/commits/') && !body) return Response.json({ tree: { sha: `base-${updates.length}` } });
        if (path.startsWith('/git/trees/')) return Response.json({ truncated: options.truncated, tree: options.entries ?? paths.map(path => ({ path, type: 'blob' })) });
        if (path === '/git/trees' && init?.method === 'POST') {
            trees.push(body);
            return Response.json({ sha: 'deletion-tree' });
        }
        if (path === '/git/commits' && init?.method === 'POST') {
            commits.push(body);
            return Response.json({ sha: 'deletion-commit' });
        }
        if (path === '/git/refs/heads/main' && init?.method === 'PATCH') {
            updates.push(body);
            if (options.fail || updates.length <= (options.conflicts ?? 0)) return new Response('Conflict', { status: 409 });
            return Response.json({});
        }
        throw new Error(`Unexpected GitHub request: ${init?.method ?? 'GET'} ${path}`);
    });
    return { trees, commits, updates };
}

function enforceWorkerRequestBudget(t: TestContext, env: ReturnType<typeof fixture>['env'], limit = 50) {
    const counts = { database: 0, github: 0, total: 0 };
    let batchDepth = 0;
    function spend(kind: 'database' | 'github') {
        counts[kind]++;
        counts.total++;
        if (counts.total > limit) throw new Error('Too many API requests by single Worker invocation');
    }
    function wrap(statement: any): any {
        return {
            bind: (...values: unknown[]) => {
                assert.ok(values.length <= 100, 'D1 allows at most 100 bound parameters per statement');
                for (const value of values) {
                    if (typeof value === 'string') assert.ok(Buffer.byteLength(value) <= 2000000, 'D1 string size limit');
                }
                return wrap(statement.bind(...values));
            },
            ...Object.fromEntries(['run', 'first', 'all'].map(method => [method, async (...args: unknown[]) => {
                if (!batchDepth) spend('database');
                return statement[method](...args);
            }])),
        };
    }
    const prepare = env.DB.prepare;
    const batch = env.DB.batch;
    const githubFetch = globalThis.fetch;
    t.mock.method(env.DB, 'prepare', (sql: string) => wrap(prepare(sql)));
    t.mock.method(env.DB, 'batch', async (statements: any[]) => {
        spend('database');
        batchDepth++;
        try { return await batch(statements); }
        finally { batchDepth--; }
    });
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        spend('github');
        return githubFetch(url, init);
    });
    return counts;
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
            const uploadedName = new URL(url).pathname.split('/').at(-1)!;
            uploaded = uploadedName.slice(0, -4);
            return Response.json({ content: { name: uploadedName } });
        }
        return new Response('image bytes');
    });
    const response = await worker.fetch(new Request('https://image.test/upload', { method: 'POST', headers: { [CONSENT_HEADER]: TERMS_VERSION }, body: ONE_PIXEL_PNG_DATA_URL }), env, ctx);
    assert.match(await response.text(), /^[0-9a-z]{32}$/);
    assert.equal(uploaded.length, 32);
    assert.ok(await getAccessTime(env, uploaded));
    await recordAccess(env, id, 1);
    const preview = await worker.fetch(new Request(`https://image.test/${id}?search`), env, ctx);
    await preview.text();
    assert.equal(await getAccessTime(env, id), 1);
    const cached = await worker.fetch(new Request(`https://image.test/${id}`, { headers: { 'If-None-Match': `"${id}"` } }), env, ctx);
    assert.equal(cached.status, 304);
    await Promise.all(pending);
    assert.ok((await getAccessTime(env, id)) > 1);
});

test('successful uploads persist complete metadata in one write', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(init?.method, 'PUT');
        return Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } });
    });
    const counts = enforceWorkerRequestBudget(t, env);
    const response = await worker.fetch(uploadRequest(), env, ctx);
    const imageId = await response.text();
    await Promise.all(pending);
    assert.equal(response.status, 200);
    assert.equal(counts.database, 5); // policy, limits, ban recheck, metadata, traffic
    assert.equal(counts.github, 1);
    const row = sqlite.prepare('SELECT * FROM image_access WHERE image_id = ?').get(imageId)!;
    assert.equal(row.moderation_status, 'approved');
    assert.equal(row.moderation_reason, 'safe');
    assert.equal(row.uploader_ip, '203.0.113.1');
    assert.equal(row.last_accessed_at, row.uploaded_at);
    assert.equal(row.moderated_at, row.uploaded_at);
});

test('upload metadata upserts preserve newer access and existing retention controls', async () => {
    const { env, sqlite } = fixture();
    await recordAccess(env, id, 500);
    await setLocked(env, id, true);
    await saveUploadedImage(env, id, '203.0.113.1', 'safe', 100);
    const row = sqlite.prepare('SELECT * FROM image_access WHERE image_id = ?').get(id)!;
    assert.equal(row.last_accessed_at, 500);
    assert.equal(row.locked, 1);
    assert.equal(row.moderation_status, 'approved');
});

test('conditional requests return 404 when image was deleted', async t => {
    const { env, ctx } = fixture();
    t.mock.method(globalThis, 'fetch', async url => new Response(null, { status: String(url).includes('/contents/') ? 404 : 200 }));
    assert.equal((await worker.fetch(new Request(`https://image.test/${id}`, { headers: { 'If-None-Match': `"${id}"` } }), env, ctx)).status, 404);
});

test('cleanup deletes inactive files, grants missing images grace and removes orphans', async t => {
    const { env } = fixture();
    const now = RETENTION_MS * 2;
    const orphan = 'c'.repeat(32);
    await recordAccess(env, id, 1);
    await recordAccess(env, orphan, 1);
    const { trees, commits } = mockCleanupGithub(t, [id, second].map(image => `${image}.jpeg`));
    await cleanupInactiveImages(env, now);
    assert.equal(commits.length, 1);
    assert.deepEqual(trees[0].tree, [{ path: `${id}.jpeg`, mode: '100644', type: 'blob', sha: null }]);
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
    const { updates } = mockCleanupGithub(t, [`${id}.jpeg`], { fail: true });
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(updates.length, 3);
    assert.equal(await getAccessTime(env, id), 1);
    assert.equal(await claimDeletion(env, id, RETENTION_MS), true);

});

test('cleanup publishes hundreds of removals in one commit using configured retention', async t => {
    const { env } = fixture();
    const configuredEnv = { ...env, IMAGE_RETENTION_DAYS: '30' };
    const ids = Array.from({ length: 205 }, (_, index) => index.toString(36).padStart(32, '0'));
    for (const imageId of ids) await recordAccess(env, imageId, 1);
    await recordAccess(env, second, 15 * 86400000);
    const paths = ids.map((imageId, index) => `${imageId}.${index % 2 ? 'png' : 'webp'}`);
    const { trees, commits, updates } = mockCleanupGithub(t, [...paths, `${second}.jpeg`, 'README.md']);
    await cleanupInactiveImages(configuredEnv, 31 * 86400000);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].message, 'Delete 205 inactive images after 30 days without access');
    assert.deepEqual(commits[0].parents, ['head-0']);
    assert.equal(trees[0].base_tree, 'base-0');
    assert.deepEqual(trees[0].tree.map((entry: any) => entry.path), paths);
    assert.ok(trees[0].tree.every((entry: any) => entry.sha === null));
    assert.deepEqual(updates, [{ sha: 'deletion-commit', force: false }]);
    assert.equal((await listAccessTimes(env)).size, 1);
    assert.equal(await getAccessTime(env, second), 15 * 86400000);
});

for (const failure of [false, true]) {
    test(`large cleanup ${failure ? 'recovers after GitHub failure' : 'completes'} within a 50-request invocation budget`, async t => {
        const { env, sqlite } = fixture();
        const now = RETENTION_MS * 3;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(console, 'error', () => {});
        const ids = Array.from({ length: 18250 }, (_, index) => index.toString(36).padStart(32, '0'));
        const expired = ids.slice(0, 12050);
        const active = ids.slice(12050, 13100);
        const locked = ids.slice(13100, 14150);
        const untracked = ids.slice(14150, 16200);
        const orphans = ids.slice(16200);
        const insert = sqlite.prepare('INSERT INTO image_access (image_id, last_accessed_at, locked) VALUES (?, ?, ?)');
        sqlite.exec('BEGIN');
        for (const image of [...expired, ...orphans]) insert.run(image, 1, 0);
        for (const image of active) insert.run(image, now, 0);
        for (const image of locked) insert.run(image, 1, 1);
        sqlite.exec('COMMIT');
        const paths = ids.slice(0, 16200).map(image => `${image}.png`);
        const { commits } = mockCleanupGithub(t, paths, { fail: failure });
        const counts = enforceWorkerRequestBudget(t, env);
        const result = await cleanupInactiveImages(env, now);
        assert.equal(result.initialized, untracked.length);
        assert.equal(result.orphanedMetadataRemoved, orphans.length);
        assert.equal(counts.database, 5);
        assert.equal(counts.github, failure ? 22 : 8);
        assert.equal(counts.total, failure ? 27 : 13);
        assert.equal(result.deleted, failure ? 0 : expired.length);
        assert.equal(result.failed, failure ? expired.length : 0);
        assert.equal(commits.length, failure ? 3 : 1);
        const rows = sqlite.prepare('SELECT image_id, last_accessed_at, locked, deleting FROM image_access').all();
        assert.equal(rows.length, active.length + locked.length + untracked.length + (failure ? expired.length : 0));
        assert.ok(rows.every(row => row.deleting === 0));
        const rowsById = new Map(rows.map(row => [row.image_id, row]));
        assert.ok(locked.every(image => rowsById.get(image)?.locked === 1));
        assert.ok([...active, ...untracked].every(image => rowsById.get(image)?.last_accessed_at === now));
    });
}

test('cleanup rebuilds its deletion commit on the latest head after a concurrent upload', async t => {
    const { env } = fixture();
    await recordAccess(env, id, 1);
    const { trees, commits, updates } = mockCleanupGithub(t, [`${id}.jpeg`], { conflicts: 1 });
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(updates.length, 2);
    assert.equal(trees[1].base_tree, 'base-1');
    assert.deepEqual(commits[1].parents, ['head-1']);
    assert.ok(updates.every(update => update.force === false));
    assert.equal(await getAccessTime(env, id), null);
});

test('cleanup atomically preserves access and locks renewed before its deletion batch', async t => {
    const { env } = fixture();
    const now = RETENTION_MS * 2;
    await recordAccess(env, id, 1);
    await recordAccess(env, second, 1);
    const originalBatch = env.DB.batch;
    env.DB.batch = async statements => {
        await recordAccess(env, id, now);
        await setLocked(env, second, true);
        return originalBatch(statements);
    };
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return Response.json({ tree: [id, second].map(image => ({ path: `${image}.jpeg`, type: 'blob' })) });
    });
    const result = await cleanupInactiveImages(env, now);
    assert.equal(calls, 1);
    assert.equal(result.deleted, 0);
    assert.equal(await getAccessTime(env, id), now);
    assert.equal(await getAccessTime(env, second), 1);
});

function adminRequest(path: string, init: RequestInit = {}, password = 'test-password') {
    return new Request(`https://image.test/api/admin${path}`, { ...init, headers: { 'Authorization': `Bearer ${password}`, 'Content-Type': 'application/json', ...init.headers } });
}
function uploadRequest(ip = '203.0.113.1') {
    return new Request('https://image.test/upload', { method: 'POST', headers: { 'CF-Connecting-IP': ip, [CONSENT_HEADER]: TERMS_VERSION }, body: ONE_PIXEL_PNG_DATA_URL });
}

test('manual cleanup requires admin authentication and same-origin POST requests', async t => {
    const { env, ctx } = fixture();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected GitHub request'); });
    assert.equal((await worker.fetch(adminRequest('/cleanup', { method: 'POST' }, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(adminRequest('/cleanup', { method: 'POST', headers: { Origin: 'https://other.test' } }), env, ctx)).status, 403);
    assert.equal((await worker.fetch(adminRequest('/cleanup'), env, ctx)).status, 404);
    assert.equal(calls, 0);
});

test('manual cleanup removes due images in one commit and preserves locked, active and untracked images', async t => {
    const { env, ctx } = fixture();
    const now = RETENTION_MS * 3;
    t.mock.method(Date, 'now', () => now);
    const active = 'c3'.repeat(16), untracked = 'd4'.repeat(16), orphan = 'e5'.repeat(16);
    await recordAccess(env, id, now - RETENTION_MS);
    await recordAccess(env, second, 1);
    await setLocked(env, second, true);
    await recordAccess(env, active, now);
    await recordAccess(env, orphan, 1);
    const { trees, commits } = mockCleanupGithub(t, [id, second, active, untracked].map(image => `${image}.png`));
    const response = await worker.fetch(adminRequest('/cleanup', { method: 'POST', body: JSON.stringify({ now: now + RETENTION_MS * 5 }) }), env, ctx);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failures, []);
    assert.equal(result.initialized, 1);
    assert.equal(result.orphanedMetadataRemoved, 1);
    assert.equal(commits.length, 1);
    assert.deepEqual(trees[0].tree.map((entry: any) => entry.path), [`${id}.png`]);
    assert.equal(await getAccessTime(env, id), null);
    assert.equal(await getAccessTime(env, second), 1);
    assert.equal(await getAccessTime(env, active), now);
    assert.equal(await getAccessTime(env, untracked), now);
    assert.equal(await getAccessTime(env, orphan), null);
});

test('manual cleanup reports deletion failures and releases claims for a retry', async t => {
    const { env, ctx } = fixture();
    const now = RETENTION_MS * 3;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'error', () => {});
    await recordAccess(env, id, 1);
    await recordAccess(env, second, 1);
    mockCleanupGithub(t, [`${id}.png`, `${second}.webp`], { fail: true });
    const response = await worker.fetch(adminRequest('/cleanup', { method: 'POST' }), env, ctx);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.success, false);
    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 2);
    assert.match(result.failures[0], /Update default branch failed \(GitHub HTTP 409\)/);
    assert.equal(await getAccessTime(env, id), 1);
    assert.equal(await getAccessTime(env, second), 1);
    assert.equal(await claimDeletion(env, id, now), true);
    assert.equal(await claimDeletion(env, second, now), true);
});

test('manual cleanup reports no-op runs and surfaces initial GitHub failures', async t => {
    const { env, ctx } = fixture();
    await recordAccess(env, id, Date.now());
    const { commits } = mockCleanupGithub(t, [`${id}.jpeg`]);
    const response = await worker.fetch(adminRequest('/cleanup', { method: 'POST' }), env, ctx);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 0);
    assert.equal(commits.length, 0);
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async () => Response.json({ truncated: true }));
    const failure = await worker.fetch(adminRequest('/cleanup', { method: 'POST' }), env, ctx);
    assert.equal(failure.status, 502);
    assert.match((await failure.json()).error, /run image cleanup.*truncated/);
    assert.ok(await getAccessTime(env, id));
});

test('repository configuration sync requires admin credentials and same-origin requests', async t => {
    const { env, ctx } = fixture();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected GitHub request'); });
    assert.equal((await worker.fetch(adminRequest('/repository-config', { method: 'POST' }, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(adminRequest('/repository-config', { method: 'POST', headers: { Origin: 'https://other.test' } }), env, ctx)).status, 403);
    assert.equal((await worker.fetch(adminRequest('/repository-config'), env, ctx)).status, 404);
    assert.equal(calls, 0);
});

test('repository configuration sync publishes the daily workflow and script in one commit', async t => {
    const { env, ctx } = fixture();
    const { trees, commits, updates } = mockCleanupGithub(t, [`${id}.png`, 'README.md']);
    const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { changed: 2, repository: 'test/images' });
    assert.equal(commits.length, 1);
    assert.deepEqual(trees[0].tree, repositoryConfigFiles.map(file => ({ ...file, type: 'blob' })));
    assert.equal(trees[0].base_tree, 'base-0');
    assert.deepEqual(commits[0].parents, ['head-0']);
    assert.deepEqual(updates, [{ sha: 'deletion-commit', force: false }]);
    for (const file of repositoryConfigFiles) {
        assert.equal(file.content, readFileSync(new URL(`../target-repository/${file.path}`, import.meta.url), 'utf8'));
    }
    const workflow = repositoryConfigFiles.find(file => file.path.endsWith('.yml'))!.content;
    assert.match(workflow, /cron: "0 0 \* \* \*"/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /RETENTION_DAYS/);
    assert.match(workflow, /--force-with-lease=/);
});

test('repository configuration sync skips unchanged files and updates only changed configuration', async t => {
    const { env, ctx } = fixture();
    const entries = repositoryConfigFiles.map(file => ({ path: file.path, mode: file.mode, type: 'blob',
        sha: createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex') }));
    const { trees, commits } = mockCleanupGithub(t, [], { entries });
    const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.deepEqual(await response.json(), { changed: 0, repository: 'test/images' });
    assert.equal(commits.length, 0);
    entries[1].sha = 'old-script-sha';
    const updated = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.deepEqual(await updated.json(), { changed: 1, repository: 'test/images' });
    assert.equal(commits.length, 1);
    assert.equal(trees[0].tree.length, 1);
    assert.equal(trees[0].tree[0].path, 'scripts/purge-deleted-image-history.sh');
});

test('failed repository configuration sync reports actionable guidance without exposing credentials', async t => {
    const { env, ctx } = fixture();
    const { updates } = mockCleanupGithub(t, [], { fail: true });
    t.mock.method(console, 'error', () => {});
    const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.match(result.error, /Update default branch failed \(GitHub HTTP 409\): Conflict/);
    assert.equal(result.operation, 'Update default branch');
    assert.equal(result.githubStatus, 409);
    assert.doesNotMatch(result.error, /test-password|Bearer/);
    assert.equal(updates.length, 3);
});

test('repository sync exposes the exact GitHub failure stage and redacts secrets', async t => {
    const { env, ctx } = fixture();
    env.GITHUB_PAT = 'github_pat_PRIVATE_TOKEN';
    t.mock.method(console, 'error', () => {});
    const scenarios = [
        { path: '', operation: 'Read repository', status: 401, message: 'Bad credentials' },
        { path: '/git/ref/heads/main', operation: 'Read default branch', status: 404, message: 'Not Found' },
        { path: '/git/trees', operation: 'Create repository tree', status: 422, message: 'Validation Failed' },
        { path: '/git/commits', operation: 'Create commit', status: 403, message: 'Resource not accessible by personal access token' },
        { path: '/git/refs/heads/main', operation: 'Update default branch', status: 422,
            message: 'refusing to allow a Personal Access Token to create or update workflow without workflow scope' },
        { path: '', operation: 'Read repository', status: 403, message: 'API rate limit exceeded' },
    ];
    for (const scenario of scenarios) {
        const { updates } = mockCleanupGithub(t, []);
        const successfulFetch = globalThis.fetch;
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            const path = new URL(url).pathname.replace('/repos/test/images', '');
            if (path === scenario.path) return Response.json({ message: scenario.message,
                errors: [{ message: `Diagnostic includes ${env.GITHUB_PAT} and ${env.ADMIN_PASSWORD}` }] },
                { status: scenario.status, headers: { 'X-GitHub-Request-Id': 'request-id' } });
            return successfulFetch(url, init);
        });
        const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
        assert.equal(response.status, 502);
        const result = await response.json();
        assert.equal(result.operation, scenario.operation);
        assert.equal(result.githubStatus, scenario.status);
        assert.equal(result.requestId, 'request-id');
        assert.ok(result.error.includes(scenario.message));
        assert.match(result.error, /\[redacted\]/);
        assert.ok(!result.error.includes(env.GITHUB_PAT));
        assert.ok(!result.error.includes(env.ADMIN_PASSWORD));
        assert.equal(updates.length, 0);
    }
});

test('repository writes do not rebuild commits for unchanged-head policy failures', async t => {
    const { env, ctx } = fixture();
    const { commits } = mockCleanupGithub(t, []);
    const successfulFetch = globalThis.fetch;
    let refusedUpdates = 0;
    let refusedResponse: Response | undefined;
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (init?.method === 'PATCH') {
            refusedUpdates++;
            refusedResponse = Response.json({ message: 'Protected branch update failed' }, { status: 422 });
            return refusedResponse;
        }
        return successfulFetch(url, init);
    });
    const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.equal(response.status, 502);
    assert.equal(commits.length, 1);
    assert.equal(refusedUpdates, 1);
    assert.equal(refusedResponse?.bodyUsed, true);
    assert.match((await response.json()).error, /Protected branch update failed/);
});

test('repository configuration sync stops before writing when the current tree is truncated', async t => {
    const { env, ctx } = fixture();
    const { trees, commits, updates } = mockCleanupGithub(t, [], { truncated: true });
    t.mock.method(console, 'error', () => {});
    const response = await worker.fetch(adminRequest('/repository-config', { method: 'POST' }), env, ctx);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /tree is truncated/);
    assert.deepEqual([trees.length, commits.length, updates.length], [0, 0, 0]);
});

test('uploads require current consent before reading data or invoking AI, including exempt IPs', async t => {
    const { env, ctx, pending } = fixture();
    await updateIpControl(env, '203.0.113.1', 'exempt');
    let calls = 0;
    t.mock.method(env.AI, 'run', async () => { calls++; throw new Error('Unexpected AI call'); });
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected GitHub call'); });
    for (const version of [null, 'old-version']) {
        const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.1' });
        if (version) headers.set(CONSENT_HEADER, version);
        const response = await worker.fetch(new Request('https://image.test/upload', { method: 'POST', headers, body: 'invalid' }), env, ctx);
        assert.equal(response.status, 428);
        assert.match(await response.text(), /accept.*Terms of Service/);
    }
    await Promise.all(pending);
    assert.equal(calls, 0);
    assert.equal(await getAccessTime(env, id), null);
});

test('model activation requires authenticated explicit operator agreement and eligibility', async t => {
    const { env, ctx } = fixture();
    const calls: unknown[][] = [];
    t.mock.method(env.AI, 'run', async (...args) => { calls.push(args); return { response: 'accepted' }; });
    const path = '/model-license';
    const accepted = JSON.stringify({ agree: true, nonEuOperator: true });
    assert.equal((await worker.fetch(adminRequest(path, { method: 'POST', body: accepted }, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(adminRequest(path, { method: 'POST', headers: { Origin: 'https://other.test' }, body: accepted }), env, ctx)).status, 403);
    for (const body of ['invalid', '{}', '{"agree":true}', '{"agree":"true","nonEuOperator":true}', '{"agree":true,"nonEuOperator":false}']) {
        assert.equal((await worker.fetch(adminRequest(path, { method: 'POST', body }), env, ctx)).status, 400);
    }
    assert.equal(calls.length, 0);
    const response = await worker.fetch(adminRequest(path, { method: 'POST', body: accepted }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(calls, [['@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' }]]);
});

test('failed account activation returns failure and license errors never auto-accept or record violations', async t => {
    const { env, ctx, pending } = fixture();
    await setFallback(env, 'deny');
    let calls = 0;
    t.mock.method(console, 'error', () => {});
    t.mock.method(env.AI, 'run', async () => { calls++; throw new Error('AiError: 5016: submit agree'); });
    assert.equal((await worker.fetch(adminRequest('/model-license', { method: 'POST', body: '{"agree":true,"nonEuOperator":true}' }), env, ctx)).status, 500);
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 503);
    await Promise.all(pending);
    assert.equal(calls, 2);
    assert.equal(await getIpControl(env, '203.0.113.1'), null);
});

test('admin APIs require credentials, reject cross-origin changes and validate lock input', async () => {
    const { env, ctx } = fixture();
    await recordAccess(env, id, 1);
    assert.equal((await worker.fetch(adminRequest('/images', {}, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(adminRequest(`/images/${id}/lock`, { method: 'PATCH', headers: { Origin: 'https://other.test' }, body: '{"locked":true}' }), env, ctx)).status, 403);
    assert.equal((await worker.fetch(adminRequest(`/images/${id}/lock`, { method: 'PATCH', body: '{"locked":"true"}' }), env, ctx)).status, 400);
    const response = await worker.fetch(adminRequest('/images'), env, ctx);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).images[0].image_id, id);
});

test('locked images survive cleanup and deletion claims prevent locking too late', async t => {
    const { env, ctx } = fixture();
    await recordAccess(env, id, 1);
    assert.equal((await worker.fetch(adminRequest(`/images/${id}/lock`, { method: 'PATCH', body: '{"locked":true}' }), env, ctx)).status, 200);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ tree: [{ path: `${id}.jpeg`, type: 'blob' }] }); });
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(requests, 1);
    assert.equal(await getAccessTime(env, id), 1);
    assert.equal(await claimDeletion(env, id, RETENTION_MS), false);
    await setLocked(env, id, false);
    assert.equal(await claimDeletion(env, id, RETENTION_MS), true);
    assert.equal(await setLocked(env, id, true), false);
    await releaseDeletion(env, id);
    assert.equal(await setLocked(env, id, true), true);
});

test('unsafe uploads record IP, warn on third strike and ban on fifth without writing GitHub', async t => {
    const { env, ctx, pending } = fixture();
    let aiCalls = 0;
    env.AI.run = async () => { aiCalls++; return { response: '{"approved":false,"reason":"explicit_sexual"}' }; };
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unsafe data reached GitHub'); });
    for (let attempt = 1; attempt <= 5; attempt++) {
        const response = await worker.fetch(uploadRequest(), env, ctx);
        assert.equal(response.status, attempt === 5 ? 403 : 400);
        if (attempt === 3) assert.match(await response.text(), /Warning/);
        assert.equal((await getIpControl(env, '203.0.113.1')).violations, attempt);
    }
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 403);
    assert.equal(aiCalls, 5);
    await Promise.all(pending);
    const events = await env.DB.prepare('SELECT * FROM moderation_events').all();
    assert.equal(events.results.length, 5);
    assert.equal(events.results[0].ip, '203.0.113.1');
});

test('concurrent violations are counted atomically and a new window resets strikes', async () => {
    const { env } = fixture();
    const now = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => recordViolation(env, '203.0.113.2', 'graphic_violence', now)));
    const control = await getIpControl(env, '203.0.113.2');
    assert.equal(control.violations, 5);
    assert.equal(control.banned_until, now + VIOLATION_WINDOW_MS);
    const reset = await recordViolation(env, '203.0.113.2', 'graphic_violence', now + VIOLATION_WINDOW_MS + 1);
    assert.equal(reset.violations, 1);
});

test('IP exemption skips AI but explicit bans still prevent upload; admin can remove each', async t => {
    t.mock.method(console, 'error', () => {});
    const { env, ctx, pending } = fixture();
    const ip = '2001:db8::1';
    assert.equal(normalizeIp('2001:0db8:0:0:0:0:0:1'), ip);
    assert.equal(normalizeIp('999.1.1.1'), null);
    const response = await worker.fetch(adminRequest('/ips', { method: 'PATCH', body: JSON.stringify({ ip: '2001:0db8:0:0:0:0:0:1', action: 'exempt' }) }), env, ctx);
    assert.equal(response.status, 200);
    env.AI.run = async () => { throw new Error('AI must not run for exemptions'); };
    t.mock.method(globalThis, 'fetch', async url => Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } }));
    assert.equal((await worker.fetch(uploadRequest(ip), env, ctx)).status, 200);
    await updateIpControl(env, ip, 'ban');
    assert.equal((await worker.fetch(uploadRequest(ip), env, ctx)).status, 403);
    await updateIpControl(env, ip, 'unban');
    assert.equal((await worker.fetch(uploadRequest(ip), env, ctx)).status, 200);
    await updateIpControl(env, ip, 'unexempt');
    await setFallback(env, 'deny');
    assert.equal((await worker.fetch(uploadRequest(ip), env, ctx)).status, 503);
    await Promise.all(pending);
});

test('deny fallback rejects inconclusive and malformed verdicts without strikes', async t => {
    const { env, ctx, pending } = fixture();
    await setFallback(env, 'deny');
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unreviewed data reached GitHub'); });
    for (const response of ['not json', '{"approved":"true","reason":"safe"}', '{"approved":false,"reason":"unassessable"}', '{"approved":true,"reason":"explicit_sexual"}']) {
        env.AI.run = async () => ({ response });
        assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 503);
    }
    assert.equal(await getIpControl(env, '203.0.113.1'), null);
    await Promise.all(pending);
});

test('traffic counts actual image response bytes, rejected requests and distinct IPs', async t => {
    const { env, ctx, pending } = fixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('1234567890'));
    const response = await worker.fetch(new Request(`https://image.test/${id}?search`, { headers: { 'CF-Connecting-IP': '203.0.113.1' } }), env, ctx);
    await response.text();
    await worker.fetch(new Request('https://image.test/upload', { method: 'POST', body: 'invalid', headers: { 'CF-Connecting-IP': '203.0.113.2', [CONSENT_HEADER]: TERMS_VERSION } }), env, ctx);
    await Promise.all(pending);
    const stats = await getTrafficStats(env, 7);
    assert.equal(stats.totals.ips, 2);
    assert.equal(stats.totals.requests, 2);
    assert.equal(stats.totals.bytes, 17);
    assert.equal(stats.daily.find(row => row.direction === 'download').bytes, 10);
    assert.equal(stats.daily.find(row => row.direction === 'upload').failed_requests, 1);
    assert.equal((await worker.fetch(adminRequest('/stats?days=999'), env, ctx)).status, 400);
    assert.equal((await worker.fetch(adminRequest('/stats?days=7'), env, ctx)).status, 200);
});

test('activity retention removes old traffic and audits without losing IP exemptions', async () => {
    const { env } = fixture();
    const now = Date.now();
    const old = now - 91 * 86400000;
    await recordTraffic(env, '203.0.113.1', 'download', 100, 200, old);
    await recordTraffic(env, '203.0.113.1', 'download', 200, 200, now);
    await recordViolation(env, '203.0.113.1', 'graphic_violence', old);
    await updateIpControl(env, '203.0.113.1', 'exempt');
    await pruneActivity(env, now);
    assert.equal((await env.DB.prepare('SELECT * FROM traffic_daily').all()).results.length, 1);
    assert.equal((await env.DB.prepare('SELECT * FROM moderation_events').all()).results.length, 0);
    assert.equal((await getIpControl(env, '203.0.113.1')).exempt, 1);
});

test('IP overview reports geolocation and upload outcomes with traffic and upload rankings', async () => {
    const { env, ctx } = fixture();
    const now = Date.now();
    const ip = '203.0.113.10';
    const old = { country: 'US', region: 'California', city: 'Los Angeles', asn: 64500, organization: 'Old network' };
    const latest = { country: 'GB', region: 'England', city: 'London', asn: 64501, organization: 'Example network' };
    await recordTraffic(env, ip, 'upload', 100, 200, now - 86400000, old);
    await recordTraffic(env, ip, 'upload', 200, 403, now, latest);
    await recordTraffic(env, ip, 'upload', 200, 503, now + 1);
    // A delayed older request must not overwrite the latest location.
    await recordTraffic(env, ip, 'upload', 100, 200, now - 1, old);
    await recordTraffic(env, '203.0.113.20', 'download', 10000, 200, now);
    await updateIpControl(env, '203.0.113.30', 'exempt');
    const overview = await listIpOverview(env, '');
    const row = overview.find(row => row.ip === ip);
    assert.equal(row.upload_requests, 4);
    assert.equal(row.successful_uploads, 2);
    assert.equal(row.failed_uploads, 2);
    assert.equal(row.uploads_today, 3);
    assert.equal(row.country, 'GB');
    assert.equal(row.city, 'London');
    assert.equal(row.asn, 64501);
    assert.equal(overview.find(row => row.ip === '203.0.113.30').upload_requests, 0);
    assert.equal((await getTrafficStats(env, 7, now, 'traffic')).ips[0].ip, '203.0.113.20');
    assert.equal((await getTrafficStats(env, 7, now, 'uploads')).ips[0].ip, ip);
    const response = await worker.fetch(adminRequest('/stats?days=7&sort=uploads'), env, ctx);
    assert.equal((await response.json()).ips[0].ip, ip);
    assert.equal((await worker.fetch(adminRequest('/stats?sort=invalid'), env, ctx)).status, 400);
});

test('traffic analytics uses one D1 batch and indexed lookups for paged and ranked locations', async t => {
    const { env, sqlite } = fixture();
    const now = Date.now();
    const ips = Array.from({ length: 160 }, (_, index) => `10.0.0.${index}`);
    const insert = sqlite.prepare(`INSERT INTO traffic_daily
        (day, ip, direction, requests, bytes, country, observed_at) VALUES (?, ?, ?, 1, ?, ?, ?)`);
    sqlite.exec('BEGIN');
    for (const [index, ip] of ips.entries()) {
        insert.run(new Date(now - 60 * 86400000).toISOString().slice(0, 10), ip, 'download', 1, 'DE', now - 60 * 86400000);
        for (let day = 0; day < 14; day++) {
            insert.run(new Date(now - day * 86400000).toISOString().slice(0, 10), ip, day % 2 ? 'upload' : 'download', (index + 1) * 10, null, now - day * 86400000);
        }
    }
    sqlite.exec('COMMIT');
    await updateIpControl(env, '10.0.1.1', 'exempt'); // A control-only IP still appears.
    const plans: string[][] = [];
    const prepare = env.DB.prepare;
    t.mock.method(env.DB, 'prepare', (sql, args = []) => {
        const statement = prepare(sql, args);
        const bind = statement.bind;
        statement.bind = (...values) => {
            if (sql.includes('locations AS')) {
                plans.push(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String(row.detail)));
            }
            return bind(...values);
        };
        return statement;
    });
    const counts = enforceWorkerRequestBudget(t, env);
    const stats = await getTrafficStats(env, 14, now);
    assert.equal(counts.database, 1);
    assert.equal(stats.ips.length, 20);
    assert.equal(stats.ips[0].ip, ips.at(-1));
    assert.equal(stats.ips[0].country, 'DE'); // Location can predate the selected range.
    assert.equal(stats.totals.ips, 160);
    assert.equal(stats.totals.requests, 160 * 14);
    const first = await listIpOverview(env, '');
    const secondPage = await listIpOverview(env, first[99].ip);
    const combined = [...first.slice(0, 100), ...secondPage];
    assert.deepEqual(combined.map(row => row.ip), [...ips, '10.0.1.1'].sort());
    assert.equal(new Set(combined.map(row => row.ip)).size, 161);
    assert.equal(counts.database, 3);
    assert.equal(plans.length, 3);
    assert.ok(plans.every(plan => plan.some(line => /SEARCH t USING INDEX idx_traffic_daily_ip_observed \(ip=\?\)/.test(line))));
});

test('geolocation comes from Cloudflare metadata and not arbitrary request headers', () => {
    const request = new Request('https://image.test/', { headers: { 'X-Country': 'US' } });
    assert.equal(requestLocation(request).country, null);
    Object.defineProperty(request, 'cf', { value: { country: 'GB', region: 'England', city: 'London', asn: 64501, asOrganization: 'Example network' } });
    assert.deepEqual(requestLocation(request), { country: 'GB', region: 'England', city: 'London', asn: 64501, organization: 'Example network' });
});

test('retention distribution handles expiry boundaries and counts all images beyond one page', async () => {
    const { env, ctx } = fixture();
    const now = RETENTION_MS * 3;
    const day = 86400000;
    const cases = [
        { key: 'a', access: now - RETENTION_MS, bucket: 'due' },
        { key: 'b', access: now - RETENTION_MS + 1, bucket: '1' },
        { key: 'c', access: now - RETENTION_MS + day + 1, bucket: '2' },
        { key: 'd', access: now, bucket: '7-14' },
    ];
    for (const row of cases) await recordAccess(env, row.key.repeat(32), row.access);
    await recordAccess(env, 'e'.repeat(32), 1);
    await setLocked(env, 'e'.repeat(32), true);
    await recordAccess(env, 'f'.repeat(32), 1);
    await claimDeletion(env, 'f'.repeat(32), now - RETENTION_MS);
    const stats = await getRetentionDistribution(env, now);
    assert.equal(stats.total, 6);
    for (const row of cases) assert.equal(stats.buckets.find(value => value.bucket === row.bucket).count, 1);
    assert.equal(stats.buckets.find(value => value.bucket === 'locked').count, 1);
    assert.equal(stats.buckets.find(value => value.bucket === 'deleting').count, 1);
    for (let index = 0; index < 60; index++) {
        const key = 'z'.repeat(30) + String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
        await recordAccess(env, key, Date.now());
    }
    const images = await (await worker.fetch(adminRequest('/images'), env, ctx)).json();
    const overview = await (await worker.fetch(adminRequest('/stats'), env, ctx)).json();
    assert.equal(images.images.length, 50);
    assert.equal(overview.retention.total, 66);
});

test('PNG and WebP uploads preserve bytes, file extensions and response MIME types', async t => {
    const { env, ctx, pending } = fixture();
    const stored = new Map<string, string>();
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const path = new URL(url).pathname.split('/').at(-1)!;
        if (init?.method === 'PUT') {
            stored.set(path, JSON.parse(String(init.body)).content);
            return Response.json({ content: { name: path } });
        }
        const bytes = stored.get(path);
        return bytes ? new Response(Buffer.from(bytes, 'base64')) : new Response(null, { status: 404 });
    });
    // A transparent one-pixel PNG must survive the complete storage round trip.
    for (const [extension, bytes] of [['png', ONE_PIXEL_PNG], ['webp', ONE_PIXEL_WEBP]]) {
        const upload = await worker.fetch(new Request('https://image.test/upload', { method: 'POST', headers: { [CONSENT_HEADER]: TERMS_VERSION }, body: `data:image/${extension};base64,${bytes}` }), env, ctx);
        assert.equal(upload.status, 200);
        const imageId = await upload.text();
        assert.equal(stored.get(`${imageId}.${extension}`), bytes);
        const image = await worker.fetch(new Request(`https://image.test/${imageId}`), env, ctx);
        assert.equal(image.headers.get('Content-Type'), `image/${extension}`);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(bytes, 'base64'));
    }
    await Promise.all(pending);
});

test('cleanup recognizes PNG and WebP paths and preserves locked images', async t => {
    const { env, sqlite } = fixture();
    await recordAccess(env, id, 1);
    await recordAccess(env, second, 1);
    await setLocked(env, second, true);
    const { trees, commits } = mockCleanupGithub(t, [`${id}.png`, `${second}.webp`, `nested/${id}.png`]);
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(commits.length, 1);
    assert.deepEqual(trees[0].tree, [{ path: `${id}.png`, mode: '100644', type: 'blob', sha: null }]);
    assert.equal(await getAccessTime(env, id), null);
    assert.ok(sqlite.prepare('SELECT locked FROM image_access WHERE image_id = ?').get(second)?.locked);
});

test('verdict parser accepts JSON and a single framed verdict but rejects prose and conflicting data', () => {
    for (const response of ['{"approved":true,"reason":"safe"}', '```json\n{"approved":true,"reason":"safe"}\n```', 'Assessment result:\n{"approved":true,"reason":"safe"}\nEnd.']) {
        assert.deepEqual(parseVerdict(response), { approved: true, reason: 'safe' });
    }
    assert.deepEqual(parseVerdict('{"approved":false,"reason":"graphic_violence"}'), { approved: false, reason: 'graphic_violence' });
    for (const response of ['The image shows a landscape.', '{"approved":true,"reason":"safe"} {"approved":false,"reason":"graphic_violence"}', '{"approved":true,"reason":"safe","extra":1}', '{"approved":true,"reason":"graphic_violence"}', '{"approved":false,"reason":"unassessable"}', '{"approved":true}', '{bad json}', '[]', null]) {
        assert.throws(() => parseVerdict(response), AssessmentError);
    }
});

test('assessment uses an explicit vision prompt and times out without waiting indefinitely', async t => {
    const { env } = fixture();
    let input: any;
    t.mock.method(env.AI, 'run', async (_, value) => { input = value; return { response: '{"approved":true,"reason":"safe"}' }; });
    assert.equal((await moderateImage(env, 'data:image/png;base64,aGVsbG8=')).approved, true);
    assert.equal(input.image, 'data:image/png;base64,aGVsbG8=');
    assert.match(input.prompt, /Output the JSON verdict/);
    assert.equal(input.temperature, 0);
    const originalTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback: () => void) => originalTimeout(callback, 0));
    t.mock.method(env.AI, 'run', () => new Promise(() => {}));
    await assert.rejects(moderateImage(env, 'data:image/png;base64,aGVsbG8='), (error: AssessmentError) => error.code === 'timeout');
});

test('default allow fallback uploads non-JSON responses and provider failures into the review queue', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    t.mock.method(console, 'error', () => {});
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(init.method, 'PUT'); writes++;
        const uploadedName = new URL(url).pathname.split('/').at(-1)!;
        const imageId = uploadedName.split('.')[0];
        // Audit and review metadata must already exist before storing the bytes.
        assert.equal(sqlite.prepare('SELECT moderation_status FROM image_access WHERE image_id = ?').get(imageId).moderation_status, 'error');
        assert.equal(sqlite.prepare('SELECT outcome FROM assessment_audit WHERE image_id = ?').get(imageId).outcome, 'pending');
        return Response.json({ content: { name: uploadedName } });
    });
    assert.equal(await getFallback(env), 'allow');
    const failures = ['The image shows a landscape.', '{"approved":false,"reason":"unassessable"}', 'provider'];
    for (const failure of failures) {
        env.AI.run = async () => {
            if (failure === 'provider') throw new Error('AI unavailable');
            return { response: failure };
        };
        const response = await worker.fetch(uploadRequest(), env, ctx);
        assert.equal(response.status, 200);
        const imageId = await response.text();
        assert.match(imageId, /^[0-9a-z]{32}$/);
        const image = sqlite.prepare('SELECT * FROM image_access WHERE image_id = ?').get(imageId);
        assert.equal(image.moderation_status, 'error');
        assert.equal(image.uploader_ip, '203.0.113.1');
        assert.ok(image.moderation_error);
        assert.equal(image.moderation_response, failure === 'provider' ? null : failure);
    }
    await Promise.all(pending);
    assert.equal(writes, 3);
    assert.equal(await getIpControl(env, '203.0.113.1'), null);
    const events = (await (await worker.fetch(adminRequest('/assessment-audit'), env, ctx)).json()).events;
    assert.equal(events.length, 3);
    assert.ok(events.every(event => event.action === 'fallback_allow' && event.outcome === 'uploaded' && event.current_status === 'error'));
    const settings = await (await worker.fetch(adminRequest('/moderation-settings'), env, ctx)).json();
    assert.deepEqual(settings.counts, [{ status: 'error', count: 3 }]);
});

test('fallback settings require authentication, validate inputs and denied attempts retain audit without image bytes', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    t.mock.method(console, 'error', () => {});
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Denied data reached storage'); });
    for (const path of ['/moderation-settings', '/assessment-audit']) {
        assert.equal((await worker.fetch(adminRequest(path, {}, 'wrong'), env, ctx)).status, 401);
    }
    assert.equal((await worker.fetch(adminRequest('/moderation-settings', { method: 'PATCH', body: '{"fallback":"deny"}', headers: { Origin: 'https://other.test' } }), env, ctx)).status, 403);
    for (const body of ['{}', '{"fallback":true}', '{"fallback":"invalid"}', 'invalid']) {
        assert.equal((await worker.fetch(adminRequest('/moderation-settings', { method: 'PATCH', body }), env, ctx)).status, 400);
    }
    assert.equal(await getFallback(env), 'allow');
    assert.equal((await worker.fetch(adminRequest('/moderation-settings', { method: 'PATCH', body: '{"fallback":"deny"}' }), env, ctx)).status, 200);
    assert.equal(await getFallback(env), 'deny');
    env.AI.run = async () => ({ response: 'The image shows a landscape.' });
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 503);
    assert.equal(await getIpControl(env, '203.0.113.1'), null);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM image_access').get().count, 0);
    const event = sqlite.prepare('SELECT * FROM assessment_audit').get();
    assert.equal(event.action, 'fallback_deny');
    assert.equal(event.outcome, 'denied');
    assert.equal(event.image_id, null);
    assert.equal(event.model_response, 'The image shows a landscape.');
    await Promise.all(pending);
});

test('upload limits can be configured independently and are exposed to uploaders', async () => {
    const { env, ctx } = fixture();
    const request = (init: RequestInit = {}, password = 'test-password') => worker.fetch(adminRequest('/upload-settings', init, password), env, ctx);
    assert.deepEqual(await (await request()).json(), { ...DEFAULT_UPLOAD_LIMITS });
    assert.equal((await request({}, 'wrong')).status, 401);
    assert.equal((await request({ method: 'PATCH', headers: { Origin: 'https://other.test' }, body: '{"maxImageDimension":null,"maxUploadBytes":null}' })).status, 403);
    for (const body of [
        '{}',
        'invalid',
        '{"maxImageDimension":0,"maxUploadBytes":null}',
        '{"maxImageDimension":100,"maxUploadBytes":-1}',
        '{"maxImageDimension":100.5,"maxUploadBytes":null}',
        '{"maxImageDimension":"100","maxUploadBytes":null}',
        '{"maxImageDimension":100}',
    ]) {
        assert.equal((await request({ method: 'PATCH', body })).status, 400, body);
    }
    assert.deepEqual(await getUploadLimits(env), { ...DEFAULT_UPLOAD_LIMITS });

    const configured = { maxImageDimension: 4096, maxUploadBytes: 25 * 1024 * 1024 };
    const updated = await request({ method: 'PATCH', body: JSON.stringify(configured) });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), configured);
    assert.deepEqual(await getUploadLimits(env), configured);
    const publicConfig = await (await worker.fetch(new Request('https://image.test/api/config'), env, ctx)).json();
    assert.equal(publicConfig.maxImageDimension, 4096);
    assert.equal(publicConfig.maxUploadBytes, 25 * 1024 * 1024);

    const unlimited = { maxImageDimension: null, maxUploadBytes: null };
    assert.deepEqual(await (await request({ method: 'PATCH', body: JSON.stringify(unlimited) })).json(), unlimited);
    assert.deepEqual(await getUploadLimits(env), unlimited);
});

test('upload body limit follows configuration and can be disabled', async t => {
    const { env, ctx, pending } = fixture();
    const configured = { ...env, AI_MODERATION_ENABLED: 'false' };
    t.mock.method(globalThis, 'fetch', async url => Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } }));
    await setUploadLimits(env, { maxImageDimension: null, maxUploadBytes: 16 });
    assert.equal((await worker.fetch(uploadRequest(), configured, ctx)).status, 413);
    await setUploadLimits(env, { maxImageDimension: null, maxUploadBytes: null });
    const accepted = await worker.fetch(uploadRequest(), configured, ctx);
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /^[0-9a-z]{32}$/);
    await Promise.all(pending);
});

test('direct uploads enforce the image dimension limit before assessment or storage', async t => {
    const { env, ctx, pending } = fixture();
    const landscape = readFileSync(new URL('./fixtures/moderation/landscape.png', import.meta.url)).toString('base64');
    const body = `data:image/png;base64,${landscape}`;
    let aiCalls = 0;
    let writes = 0;
    env.AI.run = async () => {
        aiCalls += 1;
        return { response: '{"approved":true,"reason":"safe"}' };
    };
    t.mock.method(globalThis, 'fetch', async url => {
        writes += 1;
        return Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } });
    });
    const upload = () => worker.fetch(new Request('https://image.test/upload', {
        method: 'POST',
        headers: { [CONSENT_HEADER]: TERMS_VERSION },
        body,
    }), env, ctx);

    await setUploadLimits(env, { maxImageDimension: 100, maxUploadBytes: null });
    const rejected = await upload();
    assert.equal(rejected.status, 413);
    assert.match(await rejected.text(), /512x384 exceed the configured 100 px limit/);
    assert.equal(aiCalls, 0);
    assert.equal(writes, 0);

    await setUploadLimits(env, { maxImageDimension: null, maxUploadBytes: null });
    const accepted = await upload();
    assert.equal(accepted.status, 200);
    assert.equal(aiCalls, 1);
    assert.equal(writes, 1);
    await Promise.all(pending);
});

test('fallback refuses unaudited uploads when D1 persistence fails; failed storage removes reserved metadata', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    t.mock.method(console, 'error', () => {});
    env.AI.run = async () => ({ response: 'The image shows a landscape.' });
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async () => { writes++; return new Response('Conflict', { status: 409 }); });
    const originalBatch = env.DB.batch;
    env.DB.batch = async () => { throw new Error('D1 unavailable'); };
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 503);
    assert.equal(writes, 0);
    env.DB.batch = originalBatch;
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 500);
    assert.equal(writes, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM image_access').get().count, 0);
    assert.equal(sqlite.prepare('SELECT outcome FROM assessment_audit').get().outcome, 'storage_failed');
    await Promise.all(pending);
});

test('filtered review queue and audit history paginate without skipping matching records', async () => {
    const { env, ctx, sqlite } = fixture();
    for (let index = 0; index < 60; index++) {
        const key = 'z'.repeat(30) + String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
        await recordAccess(env, key, 100);
        sqlite.prepare("UPDATE image_access SET moderation_status = 'error' WHERE image_id = ?").run(key);
        sqlite.prepare("INSERT INTO assessment_audit (action, outcome, created_at) VALUES ('fallback_deny', 'denied', ?)").run(index);
    }
    await recordAccess(env, id, 100);
    const first = await (await worker.fetch(adminRequest('/images?status=error'), env, ctx)).json();
    assert.equal(first.images.length, 50);
    const secondPage = await (await worker.fetch(adminRequest(`/images?status=error&cursor=${first.nextCursor}`), env, ctx)).json();
    assert.equal(secondPage.images.length, 10);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(new Set([...first.images, ...secondPage.images].map(row => row.image_id)).size, 60);
    assert.equal((await worker.fetch(adminRequest('/images?status=invalid'), env, ctx)).status, 400);
    const audit = await (await worker.fetch(adminRequest('/assessment-audit'), env, ctx)).json();
    assert.equal(audit.events.length, 50);
    const older = await (await worker.fetch(adminRequest(`/assessment-audit?cursor=${audit.nextCursor}`), env, ctx)).json();
    assert.equal(older.events.length, 10);
    assert.equal(older.nextCursor, null);
    assert.equal(new Set([...audit.events, ...older.events].map(row => row.id)).size, 60);
    for (const cursor of ['0', '-1', '1.5', 'abc']) {
        assert.equal((await worker.fetch(adminRequest(`/assessment-audit?cursor=${cursor}`), env, ctx)).status, 400);
    }
});

test('manual approval preserves failure evidence and manual removal deletes PNG with durable audit history', async t => {
    const { env, ctx, sqlite } = fixture();
    await recordAccess(env, id, 100);
    sqlite.prepare("UPDATE image_access SET moderation_status = 'error', moderation_error = 'invalid_json', moderation_response = 'The image shows a landscape.', uploader_ip = '203.0.113.1' WHERE image_id = ?").run(id);
    const request = (action: string) => adminRequest(`/images/${id}/review`, { method: 'POST', body: JSON.stringify({ action }) });
    assert.equal((await worker.fetch(adminRequest(`/images/${id}/review`, { method: 'POST', body: '{"action":"approve"}' }, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(request('unknown'), env, ctx)).status, 400);
    assert.equal((await worker.fetch(request('approve'), env, ctx)).status, 200);
    let row = sqlite.prepare('SELECT * FROM image_access WHERE image_id = ?').get(id);
    assert.equal(row.moderation_status, 'approved');
    assert.equal(row.moderation_reason, 'manual_approved');
    assert.equal(row.moderation_response, 'The image shows a landscape.');
    assert.equal(sqlite.prepare('SELECT action FROM assessment_audit').get().action, 'manual_approve');
    await setLocked(env, id, true);
    assert.equal((await worker.fetch(request('remove'), env, ctx)).status, 409);
    await setLocked(env, id, false);
    let removed = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (!String(url).endsWith('.png')) return new Response(null, { status: 404 });
        if (init.method === 'DELETE') {
            assert.equal(JSON.parse(init.body).sha, 'sha');
            assert.match(JSON.parse(init.body).message, /manual moderation/);
            removed = true; return Response.json({});
        }
        return Response.json({ sha: 'sha' });
    });
    assert.equal((await worker.fetch(request('remove'), env, ctx)).status, 200);
    assert.equal(removed, true);
    assert.equal(await getAccessTime(env, id), null);
    const events = (await (await worker.fetch(adminRequest('/assessment-audit'), env, ctx)).json()).events;
    assert.equal(events.length, 2);
    assert.equal(events[0].action, 'manual_remove');
    assert.equal(events[0].outcome, 'removed');
    assert.equal(events[0].current_status, null);
    assert.equal(events[1].model_response, 'The image shows a landscape.');
    assert.equal((await worker.fetch(request('approve'), env, ctx)).status, 409);
});

test('failed manual removal releases deletion claim and retains flagged image for retry', async t => {
    const { env, ctx, sqlite } = fixture();
    t.mock.method(console, 'error', () => {});
    await recordAccess(env, id, 100);
    t.mock.method(globalThis, 'fetch', async (_, init) => init.method === 'DELETE' ? new Response('Conflict', { status: 409 }) : Response.json({ sha: 'sha' }));
    assert.equal((await worker.fetch(adminRequest(`/images/${id}/review`, { method: 'POST', body: '{"action":"remove"}' }), env, ctx)).status, 500);
    const row = sqlite.prepare('SELECT * FROM image_access WHERE image_id = ?').get(id);
    assert.equal(row.deleting, 0);
    assert.equal(row.moderation_status, 'flagged');
    assert.equal(sqlite.prepare('SELECT outcome FROM assessment_audit').get().outcome, 'storage_failed');
});

test('assessment audits expire after 90 days while current review evidence remains', async () => {
    const { env, sqlite } = fixture();
    const now = Date.now();
    await recordAccess(env, id, now);
    sqlite.prepare("UPDATE image_access SET moderation_status = 'error', moderation_error = 'invalid_json' WHERE image_id = ?").run(id);
    sqlite.prepare("INSERT INTO assessment_audit (image_id, action, outcome, created_at) VALUES (?, 'fallback_allow', 'uploaded', ?)").run(id, now - 91 * 86400000);
    sqlite.prepare("INSERT INTO assessment_audit (action, outcome, created_at) VALUES ('fallback_deny', 'denied', ?)").run(now);
    await pruneActivity(env, now);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM assessment_audit').get().count, 1);
    assert.equal(sqlite.prepare('SELECT moderation_error FROM image_access WHERE image_id = ?').get(id).moderation_error, 'invalid_json');
});

test('cleanup does not erase a recent fallback reservation from a stale GitHub tree snapshot', async t => {
    const { env, sqlite } = fixture();
    const now = Date.now();
    await recordAccess(env, id, now - 1000);
    sqlite.prepare("UPDATE image_access SET moderation_status = 'error', uploaded_at = ? WHERE image_id = ?").run(now - 1000, id);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ tree: [] }));
    await cleanupInactiveImages(env, now);
    assert.notEqual(await getAccessTime(env, id), null);
    await cleanupInactiveImages(env, now + 60 * 60 * 1000 + 1);
    assert.equal(await getAccessTime(env, id), null);
});

test('object responses observed from real Workers AI are validated as strictly as text verdicts', () => {
    assert.deepEqual(parseVerdict({ approved: true, reason: 'safe' }), { approved: true, reason: 'safe' });
    assert.deepEqual(parseVerdict({ approved: false, reason: 'hate_extremism' }), { approved: false, reason: 'hate_extremism' });
    for (const response of [{ approved: 'true', reason: 'safe' }, { approved: true, reason: 'hate_extremism' }, { approved: false, reason: 'safe' }, { approved: false, reason: 'unassessable' }, { approved: true, reason: 'safe', extra: 1 }, {}, []]) {
        assert.throws(() => parseVerdict(response), AssessmentError);
    }
    const cases = [
        { response: undefined, code: 'missing_response' },
        { response: null, code: 'missing_response' },
        { response: true, code: 'invalid_response_type' },
        { response: [], code: 'invalid_response_type' },
        { response: ' '.repeat(16385), code: 'oversized_response' },
        { response: ' ', code: 'empty_response' },
    ];
    for (const item of cases) assert.throws(() => parseVerdict(item.response), (error: AssessmentError) => error.code === item.code);
});

test('real-shaped object verdicts allow safe uploads and reject prohibited uploads without fallback', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        writes++;
        return Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } });
    });
    t.mock.method(env.AI, 'run', async () => ({ response: { approved: true, reason: 'safe' }, tool_calls: [], usage: { completion_tokens: 10 } }));
    const allowed = await worker.fetch(uploadRequest(), env, ctx);
    assert.equal(allowed.status, 200);
    const imageId = await allowed.text();
    assert.equal(sqlite.prepare('SELECT moderation_status FROM image_access WHERE image_id = ?').get(imageId).moderation_status, 'approved');
    t.mock.method(env.AI, 'run', async () => ({ response: { approved: false, reason: 'hate_extremism' }, tool_calls: [], usage: { completion_tokens: 17 } }));
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 400);
    assert.equal(writes, 1);
    assert.equal((await getIpControl(env, '203.0.113.1')).violations, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM assessment_audit').get().count, 0);
    await Promise.all(pending);
});

test('inconsistent object verdicts retain serialized failure evidence in fallback audit', async t => {
    const { env, ctx, pending, sqlite } = fixture();
    t.mock.method(console, 'error', () => {});
    t.mock.method(env.AI, 'run', async () => ({ response: { approved: true, reason: 'hate_extremism' } }));
    t.mock.method(globalThis, 'fetch', async url => Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } }));
    assert.equal((await worker.fetch(uploadRequest(), env, ctx)).status, 200);
    const event = sqlite.prepare('SELECT * FROM assessment_audit').get();
    assert.equal(event.model_response, '{"approved":true,"reason":"hate_extremism"}');
    assert.match(event.error, /inconclusive/);
    assert.equal(event.action, 'fallback_allow');
    assert.equal(await getIpControl(env, '203.0.113.1'), null);
    await Promise.all(pending);
});

test('missing binding responses record structural diagnostics rather than claiming oversized output', async t => {
    const { env } = fixture();
    t.mock.method(env.AI, 'run', async () => ({ usage: { completion_tokens: 0 } }));
    await assert.rejects(moderateImage(env, 'data:image/png;base64,aGVsbG8='), (error: AssessmentError) => error.code === 'missing_response' && error.message.includes('[usage]'));
    t.mock.method(env.AI, 'run', async () => null);
    await assert.rejects(moderateImage(env, 'data:image/png;base64,aGVsbG8='), (error: AssessmentError) => error.code === 'missing_response');
});

test('authenticated model tests expose actual allow/reject verdicts without storage, strikes or fallback', async t => {
    const { env, ctx, sqlite } = fixture();
    let calls = 0;
    const request = () => adminRequest('/model-test', { method: 'POST', body: 'data:image/png;base64,aGVsbG8=' });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Model tests must not call storage'); });
    t.mock.method(env.AI, 'run', async () => { calls++; return { response: { approved: true, reason: 'safe' } }; });
    assert.equal((await worker.fetch(adminRequest('/model-test', { method: 'POST', body: 'data:image/png;base64,aGVsbG8=' }, 'wrong'), env, ctx)).status, 401);
    assert.equal((await worker.fetch(adminRequest('/model-test', { method: 'POST', body: 'data:image/png;base64,aGVsbG8=', headers: { Origin: 'https://other.test' } }), env, ctx)).status, 403);
    assert.equal((await worker.fetch(adminRequest('/model-test', { method: 'POST', body: 'not an image' }), env, ctx)).status, 400);
    assert.equal((await worker.fetch(adminRequest('/model-test', { method: 'POST', body: 'x'.repeat(10 * 1024 * 1024 + 1) }), env, ctx)).status, 413);
    assert.equal(calls, 0);
    const allowed = await worker.fetch(request(), env, ctx);
    assert.equal(allowed.headers.get('Cache-Control'), 'no-store');
    const result = await allowed.json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.verdict, { approved: true, reason: 'safe' });
    assert.equal(result.responseType, 'object');
    assert.equal(result.modelResponse, '{"approved":true,"reason":"safe"}');
    assert.ok(result.durationMs >= 0);
    t.mock.method(env.AI, 'run', async () => ({ response: '{"approved":false,"reason":"hate_extremism"}' }));
    const rejected = await (await worker.fetch(request(), env, ctx)).json();
    assert.equal(rejected.ok, true);
    assert.equal(rejected.verdict.approved, false);
    assert.equal(rejected.responseType, 'text');
    t.mock.method(env.AI, 'run', async () => ({ response: 'The image shows a landscape.' }));
    const failed = await worker.fetch(request(), env, ctx);
    assert.equal(failed.status, 422);
    const failure = await failed.json();
    assert.equal(failure.ok, false);
    assert.equal(failure.code, 'invalid_json');
    assert.equal(failure.modelResponse, 'The image shows a landscape.');
    for (const table of ['image_access', 'assessment_audit', 'moderation_events', 'ip_controls']) {
        assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
});

test('alphanumeric migration preserves existing image state and indexes while accepting digits', async () => {
    const { env, sqlite } = fixture(false);
    const legacy = 'a'.repeat(32);
    const claimed = 'b'.repeat(32);
    await recordAccess(env, legacy, 123);
    await recordAccess(env, claimed, 456);
    sqlite.prepare(`UPDATE image_access SET locked = 1, moderation_status = 'error', moderation_reason = 'invalid_json',
        moderated_at = 100, uploader_ip = '203.0.113.1', uploaded_at = 90, moderation_error = 'invalid_json: failure', moderation_response = 'The image...'
        WHERE image_id = ?`).run(legacy);
    sqlite.prepare('UPDATE image_access SET deleting = 1, deletion_started_at = 200 WHERE image_id = ?').run(claimed);
    sqlite.prepare("INSERT INTO assessment_audit (image_id, action, outcome, created_at) VALUES (?, 'fallback_allow', 'uploaded', 90)").run(legacy);
    const before = sqlite.prepare('SELECT * FROM image_access ORDER BY image_id').all();
    await assert.rejects(recordAccess(env, id, 789), /CHECK constraint/);
    sqlite.exec(readFileSync(new URL('../migrations/0006_alphanumeric_image_ids.sql', import.meta.url), 'utf8'));
    assert.deepEqual(sqlite.prepare('SELECT * FROM image_access ORDER BY image_id').all(), before);
    assert.equal(sqlite.prepare('SELECT image_id FROM assessment_audit').get().image_id, legacy);
    const indexes = sqlite.prepare("PRAGMA index_list('image_access')").all().map(row => row.name);
    assert.ok(indexes.includes('idx_image_access_last_accessed_at'));
    assert.ok(indexes.includes('idx_image_moderation_status'));
    for (const valid of [id, '0'.repeat(32), '12345678901234567890123456789012']) {
        await recordAccess(env, valid, 789);
        assert.equal(await getAccessTime(env, valid), 789);
    }
    for (const invalid of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '_'.repeat(32), 'a'.repeat(31) + '-']) {
        await assert.rejects(recordAccess(env, invalid, 789), /CHECK constraint/);
    }
});

test('all-digit image requests and admin pagination support access, traffic, locks and review', async t => {
    const { env, ctx, pending } = fixture();
    const digits = '12345678901234567890123456789012';
    await recordAccess(env, digits, 100);
    await recordAccess(env, id, 100);
    t.mock.method(globalThis, 'fetch', async () => new Response('1234567890'));
    const response = await worker.fetch(new Request(`https://image.test/${digits}`, { headers: { 'CF-Connecting-IP': '203.0.113.1' } }), env, ctx);
    assert.equal(response.status, 200);
    await response.text();
    await Promise.all(pending);
    assert.ok((await getAccessTime(env, digits)) > 100);
    assert.equal((await getTrafficStats(env, 7)).totals.bytes, 10);
    const page = await (await worker.fetch(adminRequest(`/images?cursor=${digits}`), env, ctx)).json();
    assert.equal(page.images[0].image_id, id);
    assert.equal((await worker.fetch(adminRequest(`/images/${digits}/lock`, { method: 'PATCH', body: '{"locked":true}' }), env, ctx)).status, 200);
    assert.equal((await worker.fetch(adminRequest(`/images/${digits}/review`, { method: 'POST', body: '{"action":"approve"}' }), env, ctx)).status, 200);
    for (const invalid of ['A'.repeat(32), '_'.repeat(32), digits + '1']) {
        assert.equal((await worker.fetch(adminRequest(`/images/${invalid}/lock`, { method: 'PATCH', body: '{"locked":true}' }), env, ctx)).status, 404);
        assert.equal((await worker.fetch(adminRequest(`/images/${invalid}/review`, { method: 'POST', body: '{"action":"approve"}' }), env, ctx)).status, 404);
    }
});

test('environment retention and AI configuration affect public configuration and retention buckets', async () => {
    const { env, ctx } = fixture();
    const configured = { ...env, IMAGE_RETENTION_DAYS: '30', AI_MODERATION_ENABLED: 'false', AI_MODERATION_FALLBACK: 'deny' };
    const response = await worker.fetch(new Request('https://image.test/api/config'), configured, ctx);
    assert.deepEqual(await response.json(), {
        retentionDays: 30,
        moderationEnabled: false,
        uploadPasswordRequired: false,
        ...DEFAULT_UPLOAD_LIMITS,
    });
    assert.equal(await getFallback(configured), 'deny');
    const settings = await worker.fetch(adminRequest('/moderation-settings'), configured, ctx);
    assert.equal((await settings.json()).retentionMs, 30 * 86400000);
    await recordAccess(env, id, 1000);
    const stats = await getRetentionDistribution(configured, 1000);
    assert.equal(stats.retentionMs, 30 * 86400000);
    assert.equal(stats.buckets[0].bucket, '22-30');
    assert.equal(stats.buckets[0].count, 1);
    await assert.rejects(() => getFallback({ ...env, AI_MODERATION_FALLBACK: 'invalid' }));
});

test('review status pagination uses the existing status index', async t => {
    const { env, sqlite } = fixture();
    await recordAccess(env, id, 1);
    await recordAccess(env, second, 1);
    sqlite.prepare("UPDATE image_access SET moderation_status = 'error' WHERE image_id = ?").run(second);
    let plan: string[] = [];
    const prepare = env.DB.prepare;
    t.mock.method(env.DB, 'prepare', (sql, args = []) => {
        const statement = prepare(sql, args);
        const bind = statement.bind;
        statement.bind = (...values) => {
            if (sql.startsWith('SELECT * FROM image_access WHERE')) plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => String(row.detail));
            return bind(...values);
        };
        return statement;
    });
    assert.deepEqual((await listImages(env, id, 'error')).map(row => row.image_id), [second]);
    assert.ok(plan.some(line => /SEARCH image_access USING INDEX idx_image_moderation_status/.test(line)));
});

test('admin image filters combine retention, approval source and search before pagination', async () => {
    const { env, ctx, sqlite } = fixture();
    await recordAccess(env, id, Date.now());
    await recordAccess(env, second, 1);
    sqlite.prepare("UPDATE image_access SET moderation_status = 'approved', moderation_reason = 'safe', uploader_ip = '192.0.2.1' WHERE image_id = ?").run(id);
    const request = (query: string) => worker.fetch(new Request(`https://image.test/api/admin/images?${query}`, { headers: { Authorization: 'Bearer test-password' } }), env, ctx);
    const response = await request('status=approved&source=safe&retention=active&search=192.0.2.1');
    assert.deepEqual((await response.json()).images.map((row: any) => row.image_id), [id]);
    assert.deepEqual((await (await request('retention=due')).json()).images.map((row: any) => row.image_id), [second]);
    assert.equal((await request('retention=invalid')).status, 400);
    assert.equal((await request('source=invalid')).status, 400);
    assert.equal((await request('search=%27%20OR%201=1')).status, 200);
    assert.equal((await (await request('search=%27%20OR%201=1')).json()).images.length, 0);
    assert.deepEqual((await (await request('status=approved&source=safe&locked=0&deleting=0&minDays=7&maxDays=7')).json()).images.map((row: any) => row.image_id), [id]);
    assert.deepEqual((await (await request('minDays=0&maxDays=0')).json()).images.map((row: any) => row.image_id), [second]);
    for (const query of ['minDays=-1', 'maxDays=1.5', 'minDays=8&maxDays=7', 'minDays=1000001', 'locked=2', 'deleting=true', 'maxDays=Infinity']) {
        assert.equal((await request(query)).status, 400, query);
    }
});

test('remaining day filters use rounded days and combine with fields before pagination', async t => {
    const { env, sqlite } = fixture();
    const now = 100 * 86400000;
    const day = 86400000;
    t.mock.method(Date, 'now', () => now);
    const dueAt = now - RETENTION_MS;
    for (const [key, offset] of [['a', 0], ['b', 1], ['c', day], ['d', day + 1]] as const) {
        await recordAccess(env, key.repeat(32), dueAt + offset);
    }
    assert.deepEqual((await listImages(env, '', '', '', '', '', { minDays: 1, maxDays: 1 })).map(row => row.image_id), ['b'.repeat(32), 'c'.repeat(32)]);
    assert.deepEqual((await listImages(env, '', '', '', '', '', { minDays: 2 })).map(row => row.image_id), ['d'.repeat(32)]);
    await setLocked(env, 'b'.repeat(32), true);
    sqlite.prepare('UPDATE image_access SET deleting = 1 WHERE image_id = ?').run('c'.repeat(32));
    assert.equal((await listImages(env, '', '', '', '', '', { maxDays: 1 })).length, 1);
    assert.deepEqual((await listImages(env, '', '', '', '', '', { locked: 1, deleting: 0 })).map(row => row.image_id), ['b'.repeat(32)]);
    for (let index = 0; index < 60; index++) {
        await recordAccess(env, `z${String(index).padStart(31, '0')}`, dueAt + 2 * day);
    }
    const first = await listImages(env, '', '', '', '', '', { minDays: 2, maxDays: 2, locked: 0 });
    assert.equal(first.length, 51);
    const next = await listImages(env, first[49].image_id, '', '', '', '', { minDays: 2, maxDays: 2, locked: 0 });
    assert.equal(next.length, 11);
});

test('retention aggregates day groups at exact boundaries without losing counts', async () => {
    const { env } = fixture();
    const now = 100 * 86400000;
    const day = 86400000;
    const configured = { ...env, IMAGE_RETENTION_DAYS: '90' };
    const remaining = [1, 6 * day, 6 * day + 1, 14 * day, 14 * day + 1, 21 * day, 21 * day + 1, 30 * day, 30 * day + 1, 90 * day];
    for (const [index, milliseconds] of remaining.entries()) {
        await recordAccess(env, String(index).repeat(32), now - 90 * day + milliseconds);
    }
    const stats = await getRetentionDistribution(configured, now);
    assert.equal(stats.total, 10);
    assert.deepEqual(Object.fromEntries(stats.buckets.map(row => [row.bucket, row.count])), {
        '1': 1, '6': 1, '7-14': 2, '15-21': 2, '22-30': 2, over30: 2,
    });
});

test('optional upload password rejects missing/wrong credentials before AI or storage', async t => {
    const { env, ctx } = fixture();
    let aiCalls = 0;
    let writes = 0;
    env.AI.run = async () => { aiCalls++; return { response: JSON.stringify({ approved: true, reason: 'safe' }) }; };
    t.mock.method(globalThis, 'fetch', async (url) => { writes++; return Response.json({ content: { name: new URL(url).pathname.split('/').at(-1) } }); });
    const configured = { ...env, UPLOAD_PASSWORD: 'upload-secret', AI_MODERATION_ENABLED: 'false' };
    const upload = (password: string) => worker.fetch(new Request('https://image.test/upload', { method: 'POST', headers: { [CONSENT_HEADER]: TERMS_VERSION, 'X-Upload-Password': password }, body: ONE_PIXEL_PNG_DATA_URL }), configured, ctx);
    assert.equal((await upload('')).status, 401);
    assert.equal((await upload('wrong')).status, 401);
    assert.equal(aiCalls, 0);
    assert.equal(writes, 0);
    assert.equal((await upload('upload-secret')).status, 200);
    assert.equal(aiCalls, 0);
    assert.equal(writes, 1);
    const config = await (await worker.fetch(new Request('https://image.test/api/config'), configured, ctx)).text();
    assert.equal(JSON.parse(config).uploadPasswordRequired, true);
    assert.ok(!config.includes('upload-secret'));
});

test('image storage misconfiguration and upstream failures are not reported as missing files', async t => {
    const { env, ctx } = fixture();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('Unauthorized', { status: 401 }); });
    const request = new Request(`https://image.test/${id}?search`);
    const missing = await worker.fetch(request, { ...env, GITHUB_PAT: '' }, ctx);
    assert.equal(missing.status, 503);
    assert.equal(calls, 0);
    const upstream = await worker.fetch(request, env, ctx);
    assert.equal(upstream.status, 502);
    assert.equal(calls, 1);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
    assert.equal((await worker.fetch(request, env, ctx)).status, 502);
});

test('GitHub private repository permission errors cannot masquerade as missing images', async t => {
    const { env, ctx } = fixture();
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async url => { urls.push(String(url)); return new Response(null, { status: 404 }); });
    const response = await worker.fetch(new Request(`https://image.test/${id}?search`), env, ctx);
    assert.equal(response.status, 502);
    assert.equal(urls.length, 4);
    assert.equal(urls[3], 'https://api.github.com/repos/test/images');
});
