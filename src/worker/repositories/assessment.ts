import type { Env } from '../types.ts';
import { AssessmentError } from '../services/moderation.ts';

export type Fallback = 'allow' | 'deny';
export interface FailureDetails { code: string; error: string; modelResponse: string | null }

export function assessmentFailure(error: unknown, env: Env): FailureDetails {
    const code = error instanceof AssessmentError ? error.code : 'provider_error';
    let message = error instanceof Error ? error.message : 'Unknown AI error';
    // Provider errors can include request data; do not persist credentials or image bytes.
    for (const secret of [env.GITHUB_PAT, env.ADMIN_PASSWORD, env.UPLOAD_PASSWORD]) {
        if (secret) message = message.split(secret).join('[redacted]');
    }
    message = message.replace(/data:image\/[^\s"']+/g, '[image data]').slice(0, 500);
    return { code, error: `${code}: ${message}`, modelResponse: error instanceof AssessmentError ? error.modelResponse : null };
}

export async function getFallback(env: Env): Promise<Fallback> {
    if (env.AI_MODERATION_FALLBACK !== undefined) {
        if (env.AI_MODERATION_FALLBACK !== 'allow' && env.AI_MODERATION_FALLBACK !== 'deny') throw new Error('Invalid AI_MODERATION_FALLBACK');
        return env.AI_MODERATION_FALLBACK;
    }
    const row = await env.DB.prepare('SELECT fallback FROM moderation_settings WHERE id = 1').first<{ fallback: Fallback }>();
    return row?.fallback === 'deny' ? 'deny' : 'allow';
}

export async function setFallback(env: Env, fallback: Fallback): Promise<void> {
    await env.DB.prepare('UPDATE moderation_settings SET fallback = ? WHERE id = 1').bind(fallback).run();
}

export async function recordFallback(env: Env, imageId: string | null, ip: string, fallback: Fallback, details: FailureDetails): Promise<number> {
    const now = Date.now();
    const statements = [];
    // Reserve metadata before a fallback upload, so a database failure cannot leave
    // publicly stored unassessed images without an audit trail.
    if (imageId) statements.push(env.DB.prepare(`INSERT INTO image_access
        (image_id, last_accessed_at, moderation_status, moderation_reason, moderated_at, uploader_ip, uploaded_at, moderation_error, moderation_response)
        VALUES (?, ?, 'error', ?, ?, ?, ?, ?, ?)`)
        .bind(imageId, now, details.code, now, ip, now, details.error, details.modelResponse));
    statements.push(env.DB.prepare(`INSERT INTO assessment_audit (image_id, ip, action, error, model_response, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
        .bind(imageId, ip, `fallback_${fallback}`, details.error, details.modelResponse, fallback === 'allow' ? 'pending' : 'denied', now));
    const results = await env.DB.batch<{ id: number }>(statements);
    return results[results.length - 1].results[0].id;
}

export async function finishFallback(env: Env, auditId: number, imageId: string, uploaded: boolean): Promise<void> {
    const statements = [env.DB.prepare('UPDATE assessment_audit SET outcome = ? WHERE id = ?').bind(uploaded ? 'uploaded' : 'storage_failed', auditId)];
    if (!uploaded) statements.push(env.DB.prepare('DELETE FROM image_access WHERE image_id = ?').bind(imageId));
    await env.DB.batch(statements);
}

export async function listAudit(env: Env, before: number) {
    const { results } = await env.DB.prepare(`SELECT a.*, i.moderation_status AS current_status FROM assessment_audit a
        LEFT JOIN image_access i ON i.image_id = a.image_id WHERE a.id < ? ORDER BY a.id DESC LIMIT 51`).bind(before).all();
    return { events: results.slice(0, 50), nextCursor: results.length > 50 ? results[49].id : null };
}

export async function moderationCounts(env: Env) {
    const { results } = await env.DB.prepare('SELECT moderation_status AS status, COUNT(*) AS count FROM image_access GROUP BY moderation_status').all();
    return results;
}

export async function approveImage(env: Env, imageId: string): Promise<boolean> {
    const now = Date.now();
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO assessment_audit (image_id, ip, action, error, model_response, outcome, created_at)
            SELECT image_id, uploader_ip, 'manual_approve', moderation_error, moderation_response, 'approved', ?
            FROM image_access WHERE image_id = ? AND deleting = 0`).bind(now, imageId),
        env.DB.prepare(`UPDATE image_access SET moderation_status = 'approved', moderation_reason = 'manual_approved', moderated_at = ?
            WHERE image_id = ? AND deleting = 0 RETURNING image_id`).bind(now, imageId),
    ]);
    return results[1].results.length > 0;
}

export async function claimRemoval(env: Env, imageId: string): Promise<boolean> {
    const now = Date.now();
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO assessment_audit (image_id, ip, action, error, model_response, outcome, created_at)
            SELECT image_id, uploader_ip, 'manual_remove', moderation_error, moderation_response, 'pending', ?
            FROM image_access WHERE image_id = ? AND locked = 0 AND deleting = 0`).bind(now, imageId),
        env.DB.prepare(`UPDATE image_access SET deleting = 1, deletion_started_at = ?, moderation_status = 'flagged',
            moderation_reason = 'manual_rejected', moderated_at = ? WHERE image_id = ? AND locked = 0 AND deleting = 0 RETURNING image_id`)
            .bind(now, now, imageId),
    ]);
    return results[1].results.length > 0;
}

export async function finishRemoval(env: Env, imageId: string, removed: boolean): Promise<void> {
    const statements = [env.DB.prepare(`UPDATE assessment_audit SET outcome = ? WHERE image_id = ? AND action = 'manual_remove' AND outcome = 'pending'`)
        .bind(removed ? 'removed' : 'storage_failed', imageId)];
    statements.push(removed
        ? env.DB.prepare('DELETE FROM image_access WHERE image_id = ?').bind(imageId)
        : env.DB.prepare('UPDATE image_access SET deleting = 0, deletion_started_at = NULL WHERE image_id = ?').bind(imageId));
    await env.DB.batch(statements);
}
