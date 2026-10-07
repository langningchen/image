import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker/index.ts';
import { recordAccess, initializeAccess, getAccessTime, listAccessTimes } from '../src/worker/repositories/access.ts';
import { cleanupInactiveImages } from '../src/worker/services/cleanup.ts';
import { recordViolation, getIpControl, updateIpControl, normalizeIp, VIOLATION_WINDOW_MS } from '../src/worker/repositories/ip-controls.ts';
import { setLocked, claimDeletion, releaseDeletion, getRetentionDistribution } from '../src/worker/repositories/management.ts';
import { getTrafficStats, recordTraffic, pruneActivity, listIpOverview, requestLocation } from '../src/worker/repositories/traffic.ts';
import { RETENTION_MS } from '../src/worker/constants.ts';
import { CONSENT_HEADER, TERMS_VERSION } from '../src/terms.ts';

const id = 'a'.repeat(32);
const second = 'b'.repeat(32);
function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_image_access.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0002_image_management.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0003_upload_controls_and_traffic.sql', import.meta.url), 'utf8'));
    sqlite.exec(readFileSync(new URL('../migrations/0004_ip_geolocation.sql', import.meta.url), 'utf8'));
    function prepare(sql: string, args: unknown[] = []) {
        return {
            bind: (...values: unknown[]) => prepare(sql, values),
            run: async () => ({ results: sql.includes('RETURNING') ? sqlite.prepare(sql).all(...args) : (sqlite.prepare(sql).run(...args), []) }),
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        };
    }
    const env = { DB: { prepare, batch: async (statements: any[]) => Promise.all(statements.map(s => s.run())) }, GithubOwner: 'test', GithubRepo: 'images', GithubPAT: 'test', ADMIN_PASSWORD: 'test-password', AI: { run: async () => ({ response: JSON.stringify({ approved: true, reason: 'safe' }) }) } };
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
    const response = await worker.fetch(new Request('https://image.test/upload', { method: 'POST', headers: { [CONSENT_HEADER]: TERMS_VERSION }, body: 'data:image/jpeg;base64,aGVsbG8=' }), env, ctx);
    assert.match(await response.text(), /^[a-z]{32}$/);
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

function adminRequest(path: string, init: RequestInit = {}, password = 'test-password') {
    return new Request(`https://image.test/api/admin${path}`, { ...init, headers: { 'Authorization': `Bearer ${password}`, 'Content-Type': 'application/json', ...init.headers } });
}
function uploadRequest(ip = '203.0.113.1') {
    return new Request('https://image.test/upload', { method: 'POST', headers: { 'CF-Connecting-IP': ip, [CONSENT_HEADER]: TERMS_VERSION }, body: 'data:image/jpeg;base64,aGVsbG8=' });
}

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
    assert.equal((await worker.fetch(uploadRequest(ip), env, ctx)).status, 503);
    await Promise.all(pending);
});

test('AI failures, inconclusive replies and malformed verdicts fail closed without strikes', async t => {
    const { env, ctx, pending } = fixture();
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
        { key: 'd', access: now, bucket: '7' },
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
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
    for (const [extension, bytes] of [['png', png], ['webp', 'UklGRg==']]) {
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
    const deleted: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (String(url).includes('/git/trees/')) return Response.json({ tree: [
            { path: `${id}.png`, type: 'blob' },
            { path: `${second}.webp`, type: 'blob' },
            { path: `nested/${id}.png`, type: 'blob' },
        ] });
        if (init?.method === 'DELETE') { deleted.push(String(url)); return Response.json({}); }
        return Response.json({ sha: 'sha' });
    });
    await cleanupInactiveImages(env, RETENTION_MS * 2);
    assert.equal(deleted.length, 1);
    assert.ok(deleted[0].endsWith(`${id}.png`));
    assert.equal(await getAccessTime(env, id), null);
    assert.ok(sqlite.prepare('SELECT locked FROM image_access WHERE image_id = ?').get(second)?.locked);
});
