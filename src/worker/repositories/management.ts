import { retentionMs } from '../config.ts';
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
    uploader_ip: string | null;
    uploaded_at: number | null;
    moderation_error: string | null;
    moderation_response: string | null;
}

export interface ImageFieldFilters {
    minDays?: number;
    maxDays?: number;
    locked?: number;
    deleting?: number;
}

export async function listImages(env: Env, cursor: string, status = '', retention = '', source = '', search = '', fields: ImageFieldFilters = {}): Promise<ManagedImage[]> {
    const conditions = ['image_id > ?'];
    const args: (string | number)[] = [cursor];
    if (status) { conditions.push('moderation_status = ?'); args.push(status); }
    const cutoff = Date.now() - retentionMs(env);
    if (retention === 'locked') conditions.push('locked = 1');
    if (retention === 'unlocked') conditions.push('locked = 0 AND deleting = 0');
    if (retention === 'deleting') conditions.push('deleting = 1');
    if (retention === 'due') { conditions.push('locked = 0 AND deleting = 0 AND last_accessed_at <= ?'); args.push(cutoff); }
    if (retention === 'active') { conditions.push('locked = 0 AND deleting = 0 AND last_accessed_at > ?'); args.push(cutoff); }
    if (retention === 'soon') { conditions.push('locked = 0 AND deleting = 0 AND last_accessed_at > ? AND last_accessed_at <= ?'); args.push(cutoff, cutoff + 86400000); }
    if (source) { conditions.push('moderation_reason = ?'); args.push(source); }
    if (search) { conditions.push('(instr(image_id, ?) > 0 OR uploader_ip = ?)'); args.push(search, search); }
    for (const field of ['locked', 'deleting'] as const) {
        if (fields[field] !== undefined) { conditions.push(`${field} = ?`); args.push(fields[field]); }
    }
    // Match the displayed rounded-up days: 0 includes all images already due.
    if (fields.minDays !== undefined || fields.maxDays !== undefined) {
        conditions.push('locked = 0 AND deleting = 0');
        if (fields.minDays !== undefined && fields.minDays > 0) {
            conditions.push('last_accessed_at > ?'); args.push(cutoff + (fields.minDays - 1) * 86400000);
        }
        if (fields.maxDays !== undefined) {
            conditions.push('last_accessed_at <= ?'); args.push(cutoff + fields.maxDays * 86400000);
        }
    }
    const { results } = await env.DB.prepare(
        `SELECT * FROM image_access WHERE ${conditions.join(' AND ')} ORDER BY image_id LIMIT 51`,
    ).bind(...args).all<ManagedImage>();
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

export async function saveUploadedImage(env: Env, imageId: string, ip: string, reason: string, now = Date.now()): Promise<void> {
    await env.DB.prepare(`INSERT INTO image_access
        (image_id, last_accessed_at, moderation_status, moderation_reason, moderated_at, uploader_ip, uploaded_at)
        VALUES (?, ?, 'approved', ?, ?, ?, ?)
        ON CONFLICT(image_id) DO UPDATE SET
            last_accessed_at = MAX(image_access.last_accessed_at, excluded.last_accessed_at),
            moderation_status = excluded.moderation_status, moderation_reason = excluded.moderation_reason,
            moderated_at = excluded.moderated_at, uploader_ip = excluded.uploader_ip, uploaded_at = excluded.uploaded_at`)
        .bind(imageId, now, reason, now, ip, now).run();
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
        WHEN last_accessed_at + ? > ? + 30 * 86400000 THEN 'over30'
        WHEN last_accessed_at + ? > ? + 21 * 86400000 THEN '22-30'
        WHEN last_accessed_at + ? > ? + 14 * 86400000 THEN '15-21'
        WHEN last_accessed_at + ? > ? + 6 * 86400000 THEN '7-14'
        ELSE CAST(MAX(1, CAST((last_accessed_at + ? - ? + 86399999) / 86400000 AS INTEGER)) AS TEXT)
        END AS bucket, COUNT(*) AS count FROM image_access GROUP BY bucket`)
        .bind(retentionMs(env), now, retentionMs(env), now, retentionMs(env), now, retentionMs(env), now,
            retentionMs(env), now, retentionMs(env), now).all<{ bucket: string; count: number }>();
    return { buckets: results, total: results.reduce((sum, row) => sum + row.count, 0), generatedAt: now, retentionMs: retentionMs(env) };
}
