import type { Env } from '../types.ts';
import { normalizeIp, updateIpControl } from '../repositories/ip-controls.ts';
import { getTrafficStats, listIpOverview } from '../repositories/traffic.ts';
import { IMAGE_ID_PATTERN } from '../constants.ts';
import { listImages, setLocked, getRetentionDistribution } from '../repositories/management.ts';

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function authorized(request: Request, secret: string): Promise<boolean> {
    const header = request.headers.get('Authorization');
    if (!header?.startsWith('Bearer ') || header.length > 1024) return false;
    const supplied = header.slice(7);
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([supplied, secret].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
    const left = new Uint8Array(a);
    const right = new Uint8Array(b);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
    if (!env.ADMIN_PASSWORD) return json({ error: 'Administration unavailable' }, 503);
    if (!(await authorized(request, env.ADMIN_PASSWORD))) return json({ error: 'Unauthorized' }, 401);
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Forbidden' }, 403);
    try {
        if (request.method === 'GET' && url.pathname === '/api/admin/images') {
            const cursor = url.searchParams.get('cursor') ?? '';
            if (cursor && !IMAGE_ID_PATTERN.test(cursor)) return json({ error: 'Invalid cursor' }, 400);
            const rows = await listImages(env, cursor);
            const images = rows.slice(0, 50);
            return json({ images, nextCursor: rows.length > 50 ? images[49].image_id : null });
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/stats') {
            const days = Number(url.searchParams.get('days') ?? 7);
            if (!Number.isInteger(days) || days < 1 || days > 90) return json({ error: 'Invalid range' }, 400);
            const order = url.searchParams.get('sort') ?? 'traffic';
            if (order !== 'traffic' && order !== 'uploads') return json({ error: 'Invalid order' }, 400);
            const [traffic, retention] = await Promise.all([getTrafficStats(env, days, Date.now(), order), getRetentionDistribution(env)]);
            return json({ ...traffic, retention });
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/ips') {
            const cursor = url.searchParams.get('cursor') ?? '';
            if (cursor && cursor !== 'unknown' && !normalizeIp(cursor)) return json({ error: 'Invalid cursor' }, 400);
            const results = await listIpOverview(env, cursor);
            return json({ ips: results.slice(0, 100), nextCursor: results.length > 100 ? results[99].ip : null });
        }
        if (request.method === 'PATCH' && url.pathname === '/api/admin/ips') {
            let body: unknown;
            try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
            if (!body || typeof body !== 'object' || !('ip' in body) || typeof body.ip !== 'string' || !('action' in body)
                || typeof body.action !== 'string' || !['exempt', 'unexempt', 'ban', 'unban'].includes(body.action)) return json({ error: 'Invalid request' }, 400);
            const ip = normalizeIp(body.ip);
            if (!ip) return json({ error: 'Invalid IP address' }, 400);
            await updateIpControl(env, ip, body.action as 'exempt' | 'unexempt' | 'ban' | 'unban');
            return json({ success: true });
        }
        const match = url.pathname.match(/^\/api\/admin\/images\/([a-z]{32})\/lock$/);
        if (request.method === 'PATCH' && match) {
            let body: unknown;
            try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
            if (!body || typeof body !== 'object' || !('locked' in body) || typeof body.locked !== 'boolean') {
                return json({ error: 'Invalid request' }, 400);
            }
            const updated = await setLocked(env, match[1], body.locked);
            return updated ? json({ locked: body.locked }) : json({ error: 'Image unavailable or deletion already started' }, 409);
        }
        return json({ error: 'Not found' }, 404);
    } catch (error) {
        console.error('Administration failed:', error);
        return json({ error: 'Request failed' }, 500);
    }
}
