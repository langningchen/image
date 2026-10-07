import type { Env } from '../types.ts';

const UPSERT = `INSERT INTO image_access (image_id, last_accessed_at) VALUES (?, ?)
    ON CONFLICT(image_id) DO UPDATE SET last_accessed_at = excluded.last_accessed_at
    WHERE excluded.last_accessed_at > image_access.last_accessed_at`;

export async function recordAccess(env: Env, imageId: string, timestamp = Date.now()): Promise<void> {
    await env.DB.prepare(UPSERT).bind(imageId, timestamp).run();
}

export async function initializeAccess(env: Env, imageIds: string[], timestamp: number): Promise<void> {
    if (!imageIds.length) return;
    // Never overwrite an access recorded after the cleanup snapshot was read.
    await env.DB.batch(imageIds.map(id => env.DB.prepare(
        'INSERT INTO image_access (image_id, last_accessed_at) VALUES (?, ?) ON CONFLICT(image_id) DO NOTHING',
    ).bind(id, timestamp)));
}

export async function listAccessTimes(env: Env): Promise<Map<string, number>> {
    const times = new Map<string, number>();
    let cursor = '';
    // Keyset pagination bounds each query's response size.
    while (true) {
        const { results } = await env.DB.prepare(
            'SELECT image_id, last_accessed_at FROM image_access WHERE image_id > ? ORDER BY image_id LIMIT 1000',
        ).bind(cursor).all<{ image_id: string; last_accessed_at: number }>();
        for (const row of results) times.set(row.image_id, row.last_accessed_at);
        if (results.length < 1000) return times;
        cursor = results[results.length - 1].image_id;
    }
}

export async function getAccessTime(env: Env, imageId: string): Promise<number | null> {
    const row = await env.DB.prepare('SELECT last_accessed_at FROM image_access WHERE image_id = ?')
        .bind(imageId).first<{ last_accessed_at: number }>();
    return row?.last_accessed_at ?? null;
}

export async function removeAccess(env: Env, imageId: string): Promise<void> {
    await env.DB.prepare('DELETE FROM image_access WHERE image_id = ?').bind(imageId).run();
}

export async function removeAccessBatch(env: Env, imageIds: string[], snapshotTime: number): Promise<void> {
    if (!imageIds.length) return;
    await env.DB.batch(imageIds.map(id => env.DB.prepare(
        'DELETE FROM image_access WHERE image_id = ? AND last_accessed_at < ?',
    ).bind(id, snapshotTime)));
}
