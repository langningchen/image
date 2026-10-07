import type { Env } from '../types.ts';

export const VIOLATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WARNING_THRESHOLD = 3;
export const BAN_THRESHOLD = 5;
export interface IpControl { ip: string; exempt: number; violations: number; window_started_at: number; banned_until: number }

export function normalizeIp(value: string): string | null {
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
        const parts = value.split('.').map(Number);
        return parts.every(part => part <= 255) ? parts.join('.') : null;
    }
    if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return null;
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
}

export function clientIp(request: Request): string {
    // Cloudflare supplies this header; never trust X-Forwarded-For for enforcement.
    return normalizeIp(request.headers.get('CF-Connecting-IP') ?? '') ?? 'unknown';
}

export async function getIpControl(env: Env, ip: string): Promise<IpControl | null> {
    return env.DB.prepare('SELECT * FROM ip_controls WHERE ip = ?').bind(ip).first<IpControl>();
}

export async function recordViolation(env: Env, ip: string, reason: string, now = Date.now()): Promise<IpControl> {
    const expired = now - VIOLATION_WINDOW_MS;
    // Atomic counter and audit insertion; simultaneous uploads cannot lose increments.
    const [result] = await env.DB.batch<IpControl>([
        env.DB.prepare(`INSERT INTO ip_controls (ip, window_started_at, violations) VALUES (?, ?, 1)
            ON CONFLICT(ip) DO UPDATE SET
            violations = CASE WHEN window_started_at <= ? THEN 1 ELSE violations + 1 END,
            window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END,
            banned_until = CASE WHEN window_started_at > ? AND violations + 1 >= ? THEN MAX(banned_until, ?) ELSE banned_until END
            RETURNING *`).bind(ip, now, expired, expired, now, expired, BAN_THRESHOLD, now + VIOLATION_WINDOW_MS),
        env.DB.prepare('INSERT INTO moderation_events (ip, reason, created_at) VALUES (?, ?, ?)').bind(ip, reason, now),
    ]);
    return result.results[0];
}

export async function updateIpControl(env: Env, ip: string, action: 'exempt' | 'unexempt' | 'ban' | 'unban', now = Date.now()): Promise<void> {
    await env.DB.prepare('INSERT INTO ip_controls (ip) VALUES (?) ON CONFLICT(ip) DO NOTHING').bind(ip).run();
    const sql = action === 'exempt' ? 'exempt = 1' : action === 'unexempt' ? 'exempt = 0'
        : action === 'ban' ? 'banned_until = ?' : 'banned_until = 0, violations = 0, window_started_at = 0';
    const values = action === 'ban' ? [now + VIOLATION_WINDOW_MS, ip] : [ip];
    await env.DB.prepare(`UPDATE ip_controls SET ${sql} WHERE ip = ?`).bind(...values).run();
}
