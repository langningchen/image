import type { Env } from '../types.ts';
import { normalizeIp, updateIpControl } from '../repositories/ip-controls.ts';
import { getTrafficStats, listIpOverview } from '../repositories/traffic.ts';
import { IMAGE_ID_PATTERN } from '../constants.ts';
import { listImages, setLocked, getRetentionDistribution } from '../repositories/management.ts';
import { getFallback, setFallback, listAudit, moderationCounts, approveImage, claimRemoval, finishRemoval } from '../repositories/assessment.ts';
import { deleteImageFromGithub } from '../repositories/github.ts';
import { assessImage } from '../services/moderation.ts';
import { assessmentFailure } from '../repositories/assessment.ts';

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
        if (request.method === 'POST' && url.pathname === '/api/admin/model-test') {
            const reader = request.body?.getReader();
            if (!reader) return json({ error: 'Image data required' }, 400);
            const decoder = new TextDecoder();
            let image = '';
            let bytes = 0;
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 10 * 1024 * 1024) {
                    await reader.cancel();
                    return json({ error: 'Image too large' }, 413);
                }
                image += decoder.decode(chunk.value, { stream: true });
            }
            image += decoder.decode();
            const match = image.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
            if (!match || match[1].length % 4 !== 0) return json({ error: 'Invalid image data' }, 400);
            try {
                return json({ ok: true, ...(await assessImage(env, image)) });
            } catch (error) {
                const details = assessmentFailure(error, env);
                return json({ ok: false, ...details }, 422);
            }
        }
        if (url.pathname === '/api/admin/moderation-settings') {
            if (request.method === 'GET') return json({ fallback: await getFallback(env), counts: await moderationCounts(env) });
            if (request.method === 'PATCH') {
                if (env.AI_MODERATION_FALLBACK !== undefined) return json({ error: 'Fallback is managed by AI_MODERATION_FALLBACK' }, 409);
                let body: unknown;
                try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
                if (!body || typeof body !== 'object' || !('fallback' in body) || (body.fallback !== 'allow' && body.fallback !== 'deny')) {
                    return json({ error: 'Fallback must be allow or deny' }, 400);
                }
                await setFallback(env, body.fallback);
                return json({ fallback: body.fallback });
            }
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/assessment-audit') {
            const cursor = url.searchParams.get('cursor');
            const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
            if (!Number.isSafeInteger(before) || before <= 0) return json({ error: 'Invalid cursor' }, 400);
            return json(await listAudit(env, before));
        }
        const review = url.pathname.match(/^\/api\/admin\/images\/([^/]+)\/review$/);
        if (request.method === 'POST' && review && IMAGE_ID_PATTERN.test(review[1])) {
            let body: unknown;
            try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
            if (!body || typeof body !== 'object' || !('action' in body) || !['approve', 'remove'].includes(String(body.action))) {
                return json({ error: 'Invalid review action' }, 400);
            }
            const imageId = review[1];
            if (body.action === 'approve') {
                return await approveImage(env, imageId) ? json({ success: true }) : json({ error: 'Image unavailable or being deleted' }, 409);
            }
            if (!(await claimRemoval(env, imageId))) return json({ error: 'Unlock the image first; it may be unavailable or being deleted' }, 409);
            try {
                // Check each supported extension; legacy records do not store it.
                for (const extension of ['jpeg', 'png', 'webp']) await deleteImageFromGithub(env, imageId, extension, 'after manual moderation review');
            } catch (error) {
                await finishRemoval(env, imageId, false);
                throw error;
            }
            await finishRemoval(env, imageId, true);
            return json({ success: true });
        }
        if (request.method === 'POST' && url.pathname === '/api/admin/model-license') {
            let body: unknown;
            try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
            if (!body || typeof body !== 'object' || !('agree' in body) || body.agree !== true
                || !('nonEuOperator' in body) || body.nonEuOperator !== true) {
                return json({ error: 'Explicit license acceptance and operator eligibility are required' }, 400);
            }
            // Only the authenticated operator can accept the account-level license.
            await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
            return json({ success: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/admin/images') {
            const cursor = url.searchParams.get('cursor') ?? '';
            if (cursor && !IMAGE_ID_PATTERN.test(cursor)) return json({ error: 'Invalid cursor' }, 400);
            const status = url.searchParams.get('status') ?? '';
            if (!['', 'pending', 'approved', 'flagged', 'error'].includes(status)) return json({ error: 'Invalid moderation status' }, 400);
            const rows = await listImages(env, cursor, status);
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
        const match = url.pathname.match(/^\/api\/admin\/images\/([^/]+)\/lock$/);
        if (request.method === 'PATCH' && match && IMAGE_ID_PATTERN.test(match[1])) {
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
