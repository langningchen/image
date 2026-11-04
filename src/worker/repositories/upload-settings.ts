import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../../uploadLimits.ts';
import type { Env } from '../types.ts';

export async function getUploadLimits(env: Env): Promise<UploadLimits> {
    const row = await env.DB.prepare(`SELECT max_image_dimension, max_upload_bytes
        FROM upload_settings WHERE id = 1`).first<{ max_image_dimension: number | null; max_upload_bytes: number | null }>();
    if (!row) return { ...DEFAULT_UPLOAD_LIMITS };
    return {
        maxImageDimension: row.max_image_dimension,
        maxUploadBytes: row.max_upload_bytes,
    };
}

export async function setUploadLimits(env: Env, limits: UploadLimits): Promise<void> {
    await env.DB.prepare(`INSERT INTO upload_settings (id, max_image_dimension, max_upload_bytes)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            max_image_dimension = excluded.max_image_dimension,
            max_upload_bytes = excluded.max_upload_bytes`)
        .bind(limits.maxImageDimension, limits.maxUploadBytes)
        .run();
}
