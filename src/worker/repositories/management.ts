import { RETENTION_MS } from '../constants.ts';
import type { Env } from '../types.ts';

export interface ManagedImage {
    image_id: string;
    last_accessed_at: number;
    locked: number;
    deleting: number;
    deletion_started_at: number | null;
    moderation_status: 'pending' | 'approved' | 'flagged' | 'error';
    moderation_reason: string | null;
    moderated_at: number | null;
}

export async function listImages(env: Env, cursor: string): Promise<ManagedImage[]> {
    const { results } = await env.DB.prepare(
        'SELECT * FROM image_access WHERE image_id > ? ORDER BY image_id LIMIT 51',
    ).bind(cursor).all<ManagedImage>();
    return results;
}

export async function setLocked(env: Env, imageId: string, locked: boolean): Promise<boolean> {
    const result = await env.DB.prepare(
        'UPDATE image_access SET locked = ? WHERE image_id = ? AND deleting = 0 RETURNING image_id',
    ).bind(locked ? 1 : 0, imageId).first();
    return result !== null;
}

export async function saveModeration(env: Env, imageId: string, status: ManagedImage['moderation_status'], reason: string, now = Date.now()): Promise<void> {
    await env.DB.prepare(
        'UPDATE image_access SET moderation_status = ?, moderation_reason = ?, moderated_at = ? WHERE image_id = ?',
    ).bind(status, reason, now, imageId).run();
}

export async function claimDeletion(env: Env, imageId: string, cutoff: number): Promise<boolean> {
    const row = await env.DB.prepare(
        'UPDATE image_access SET deleting = 1, deletion_started_at = ? WHERE image_id = ? AND locked = 0 AND deleting = 0 AND last_accessed_at <= ? RETURNING image_id',
    ).bind(Date.now(), imageId, cutoff).first();
    return row !== null;
}

export async function releaseDeletion(env: Env, imageId: string): Promise<void> {
    await env.DB.prepare('UPDATE image_access SET deleting = 0, deletion_started_at = NULL WHERE image_id = ?').bind(imageId).run();
}

export async function recoverDeletionClaims(env: Env, now: number): Promise<void> {
    await env.DB.prepare('UPDATE image_access SET deleting = 0, deletion_started_at = NULL WHERE deleting = 1 AND deletion_started_at < ?')
        .bind(now - 60 * 60 * 1000).run();
}

export async function getRetentionDistribution(env: Env, now = Date.now()) {
    const { results } = await env.DB.prepare(`SELECT CASE
        WHEN locked = 1 THEN 'locked'
        WHEN deleting = 1 THEN 'deleting'
        WHEN last_accessed_at + ? <= ? THEN 'due'
        ELSE CAST(MIN(7, MAX(1, CAST((last_accessed_at + ? - ? + 86399999) / 86400000 AS INTEGER))) AS TEXT)
        END AS bucket, COUNT(*) AS count FROM image_access GROUP BY bucket`)
        .bind(RETENTION_MS, now, RETENTION_MS, now).all<{ bucket: string; count: number }>();
    return { buckets: results, total: results.reduce((sum, row) => sum + row.count, 0), generatedAt: now };
}
