import type { Env } from '../types.ts';
import { clientIp } from './ip-controls.ts';

export interface Geolocation {
    country: string | null;
    region: string | null;
    city: string | null;
    asn: number | null;
    organization: string | null;
}

export function requestLocation(request: Request): Geolocation {
    const cf = request.cf;
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.slice(0, 200) : null;
    return { country: text(cf?.country), region: text(cf?.region), city: text(cf?.city),
        asn: typeof cf?.asn === 'number' && Number.isSafeInteger(cf.asn) ? cf.asn : null,
        organization: text(cf?.asOrganization) };
}

export async function recordTraffic(env: Env, ip: string, direction: 'upload' | 'download', bytes: number, status: number, now = Date.now(), location?: Geolocation): Promise<void> {
    await env.DB.prepare(`INSERT INTO traffic_daily (day, ip, direction, requests, bytes, failed_requests, country, region, city, asn, organization, observed_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, ip, direction) DO UPDATE SET requests = requests + 1, bytes = bytes + excluded.bytes,
        failed_requests = failed_requests + excluded.failed_requests,
        country = CASE WHEN excluded.observed_at >= observed_at THEN COALESCE(excluded.country, country) ELSE country END, region = CASE WHEN excluded.observed_at >= observed_at THEN COALESCE(excluded.region, region) ELSE region END,
        city = CASE WHEN excluded.observed_at >= observed_at THEN COALESCE(excluded.city, city) ELSE city END, asn = CASE WHEN excluded.observed_at >= observed_at THEN COALESCE(excluded.asn, asn) ELSE asn END,
        organization = CASE WHEN excluded.observed_at >= observed_at THEN COALESCE(excluded.organization, organization) ELSE organization END, observed_at = MAX(observed_at, excluded.observed_at)`)
        .bind(new Date(now).toISOString().slice(0, 10), ip, direction, bytes, status >= 400 ? 1 : 0,
            location?.country ?? null, location?.region ?? null, location?.city ?? null,
            location?.asn ?? null, location?.organization ?? null, now).run();
}

const IP_ROLLUP = `WITH locations AS (
    SELECT ip, country, region, city, asn, organization,
        ROW_NUMBER() OVER (PARTITION BY ip ORDER BY observed_at DESC, day DESC, direction) AS position
    FROM traffic_daily WHERE country IS NOT NULL OR region IS NOT NULL OR city IS NOT NULL OR asn IS NOT NULL OR organization IS NOT NULL
), uploads AS (
    SELECT ip, SUM(requests) AS requests, SUM(bytes) AS bytes, SUM(failed_requests) AS failed_requests,
        SUM(CASE WHEN direction = 'upload' THEN requests ELSE 0 END) AS upload_requests,
        SUM(CASE WHEN direction = 'upload' THEN requests - failed_requests ELSE 0 END) AS successful_uploads,
        SUM(CASE WHEN direction = 'upload' THEN failed_requests ELSE 0 END) AS failed_uploads,
        SUM(CASE WHEN direction = 'upload' AND day = ? THEN requests ELSE 0 END) AS uploads_today
    FROM traffic_daily WHERE day >= ? GROUP BY ip
)`;

export async function listIpOverview(env: Env, cursor: string) {
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(`${IP_ROLLUP}, known_ips AS (
        SELECT ip FROM ip_controls UNION SELECT ip FROM uploads
    ) SELECT k.ip, COALESCE(c.exempt, 0) AS exempt, COALESCE(c.violations, 0) AS violations,
        COALESCE(c.window_started_at, 0) AS window_started_at, COALESCE(c.banned_until, 0) AS banned_until,
        COALESCE(u.upload_requests, 0) AS upload_requests, COALESCE(u.successful_uploads, 0) AS successful_uploads,
        COALESCE(u.failed_uploads, 0) AS failed_uploads, COALESCE(u.uploads_today, 0) AS uploads_today,
        l.country, l.region, l.city, l.asn, l.organization
        FROM known_ips k LEFT JOIN ip_controls c ON c.ip = k.ip LEFT JOIN uploads u ON u.ip = k.ip
        LEFT JOIN locations l ON l.ip = k.ip AND l.position = 1
        WHERE k.ip > ? ORDER BY k.ip LIMIT 101`).bind(today, '', cursor).all<{ ip: string }>();
    return results;
}

export function trackResponse(request: Request, response: Response, env: Env, ctx: ExecutionContext, uploadBytes?: number): Response {
    const ip = clientIp(request);
    const started = Date.now();
    const direction = uploadBytes === undefined ? 'download' : 'upload';
    const save = (bytes: number) => recordTraffic(env, ip, direction, bytes, response.status, started, requestLocation(request))
        .catch(error => console.error('Could not record traffic:', error));
    if (uploadBytes !== undefined || !response.body) {
        ctx.waitUntil(save(uploadBytes ?? 0));
        return response;
    }
    const reader = response.body.getReader();
    let bytes = 0;
    let finished = false;
    let resolveDone: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const finish = async () => {
        if (finished) return;
        finished = true;
        await save(bytes);
        resolveDone();
    };
    ctx.waitUntil(done);
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read();
                if (result.done) { controller.close(); await finish(); }
                else { bytes += result.value.byteLength; controller.enqueue(result.value); }
            } catch (error) { controller.error(error); await finish(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function getTrafficStats(env: Env, days: number, now = Date.now(), order: 'traffic' | 'uploads' = 'traffic') {
    const since = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const [daily, ips, totals] = await Promise.all([
        env.DB.prepare(`SELECT day, direction, SUM(requests) AS requests, SUM(bytes) AS bytes,
            SUM(failed_requests) AS failed_requests, COUNT(DISTINCT ip) AS ips
            FROM traffic_daily WHERE day >= ? GROUP BY day, direction ORDER BY day`).bind(since).all(),
        env.DB.prepare(`${IP_ROLLUP} SELECT u.*, l.country, l.region, l.city, l.asn, l.organization
            FROM uploads u LEFT JOIN locations l ON l.ip = u.ip AND l.position = 1
            ORDER BY ${order === 'uploads' ? 'u.upload_requests' : 'u.bytes'} DESC, u.ip LIMIT 20`).bind(today, since).all(),
        env.DB.prepare(`SELECT COUNT(DISTINCT ip) AS ips, COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(CASE WHEN direction = 'upload' THEN requests ELSE 0 END), 0) AS upload_requests
            FROM traffic_daily WHERE day >= ?`).bind(since).first(),
    ]);
    return { daily: daily.results, ips: ips.results, totals, since };
}

export async function pruneActivity(env: Env, now: number): Promise<void> {
    const cutoff = now - 90 * 86400000;
    await env.DB.batch([
        env.DB.prepare('DELETE FROM traffic_daily WHERE day < ?').bind(new Date(cutoff).toISOString().slice(0, 10)),
        env.DB.prepare('DELETE FROM moderation_events WHERE created_at < ?').bind(cutoff),
    ]);
}
