import type { Env } from '../types.ts';

// Pass IDs as JSON rather than one bound parameter per image (D1 permits 100).
// Keep each statement small; D1 executes the statements in a batch transaction.
function idBatches(ids: string[], size = 1000): string[] {
    const batches: string[] = [];
    for (let index = 0; index < ids.length; index += size) {
        batches.push(JSON.stringify(ids.slice(index, index + size)));
    }
    return batches;
}

export async function prepareImageCleanup(env: Env, imageIds: string[], now: number, cutoff: number) {
    const tracked = await env.DB.prepare('SELECT COUNT(*) AS count FROM image_access').first<{ count: number }>();
    const batches = idBatches(imageIds);
    if (!batches.length) return { tracked: tracked?.count ?? 0, initialized: 0, claimedIds: [] as string[] };
    const results = await env.DB.batch<{ image_id: string }>([
        ...batches.map(ids => env.DB.prepare(
            `INSERT INTO image_access (image_id, last_accessed_at)
             SELECT value, ? FROM json_each(?) WHERE true
             ON CONFLICT(image_id) DO NOTHING`,
        ).bind(now, ids)),
        ...batches.map(ids => env.DB.prepare(
            `UPDATE image_access SET deleting = 1, deletion_started_at = ?
             WHERE image_id IN (SELECT value FROM json_each(?))
               AND locked = 0 AND deleting = 0 AND last_accessed_at <= ?
             RETURNING image_id`,
        ).bind(now, ids, cutoff)),
    ]);
    const initialized = results.slice(0, batches.length).reduce((sum, result) => sum + result.meta.changes, 0);
    return {
        tracked: (tracked?.count ?? 0) + initialized,
        initialized,
        // The conditional UPDATE checks the latest access and lock state atomically.
        claimedIds: results.slice(batches.length).flatMap(result => result.results.map(row => row.image_id)),
    };
}

export async function finishImageCleanup(env: Env, imageIds: string[], deleted: boolean): Promise<void> {
    const batches = idBatches(imageIds);
    if (!batches.length) return;
    const sql = deleted
        ? 'DELETE FROM image_access WHERE deleting = 1 AND image_id IN (SELECT value FROM json_each(?))'
        : 'UPDATE image_access SET deleting = 0, deletion_started_at = NULL WHERE image_id IN (SELECT value FROM json_each(?))';
    await env.DB.batch(batches.map(ids => env.DB.prepare(sql).bind(ids)));
}

export async function removeOrphanedImageAccess(env: Env, imageIds: string[], now: number): Promise<number> {
    // The complete GitHub tree is limited to 100,000 entries. Chunks of 10,000
    // keep each JSON value below D1's 2 MB limit and the bind count below 100.
    const batches = idBatches(imageIds, 10000);
    const exclusions = batches.map(() => 'AND image_id NOT IN (SELECT value FROM json_each(?))').join('\n');
    const result = await env.DB.prepare(
        `DELETE FROM image_access WHERE last_accessed_at < ?
         AND (uploaded_at IS NULL OR uploaded_at < ?) ${exclusions}`,
    ).bind(now, now - 60 * 60 * 1000, ...batches).run();
    return result.meta.changes;
}
