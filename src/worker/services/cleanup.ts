import type { Env } from '../types.ts';
import { claimDeletion, releaseDeletion, recoverDeletionClaims } from '../repositories/management.ts';
import { RETENTION_MS } from '../constants.ts';
import { listCurrentImageIds, deleteImageFromGithub } from '../repositories/github.ts';
import { listAccessTimes, getAccessTime, initializeAccess, removeAccess, removeAccessBatch } from '../repositories/access.ts';
const BATCH_SIZE = 100;

export async function cleanupInactiveImages(env: Env, now: number): Promise<void> {
    await recoverDeletionClaims(env, now);
    const currentImageIds = await listCurrentImageIds(env);
    const accessTimes = await listAccessTimes(env);
    const cutoff = now - RETENTION_MS;

    // Give images uploaded before this feature a full seven days from the first
    // cleanup run instead of deleting them without a known last-access time.
    const missingIds = [...currentImageIds].filter((imageId) => !accessTimes.has(imageId));
    for (let index = 0; index < missingIds.length; index += BATCH_SIZE) {
        await initializeAccess(env, missingIds.slice(index, index + BATCH_SIZE), now);
    }

    const staleIds = [...accessTimes]
        .filter(([imageId, lastAccessedAt]) => currentImageIds.has(imageId) && lastAccessedAt <= cutoff)
        .map(([imageId]) => imageId);

    let deletedCount = 0;
    // GitHub's Contents API creates one commit per deletion. Keep these calls
    // serial so parallel commits do not race while updating the same branch.
    for (const imageId of staleIds) {
        try {
            // Re-read immediately before deletion to reduce the chance that a
            // concurrent real view loses a just-renewed image.
            const latestAccess = await getAccessTime(env, imageId);
            if (latestAccess === null || latestAccess > cutoff) {
                continue;
            }

            if (!(await claimDeletion(env, imageId, cutoff))) continue;
            await deleteImageFromGithub(env, imageId);
            await removeAccess(env, imageId);
            deletedCount += 1;
        } catch (error) {
            await releaseDeletion(env, imageId);
            console.error('Scheduled image deletion failed:', imageId, error);
        }
    }

    const orphanedIds = [...accessTimes.keys()].filter((imageId) => !currentImageIds.has(imageId));
    for (let index = 0; index < orphanedIds.length; index += BATCH_SIZE) {
        await removeAccessBatch(env, orphanedIds.slice(index, index + BATCH_SIZE), now);
    }

    console.log('Image cleanup complete', {
        tracked: accessTimes.size + missingIds.length,
        initialized: missingIds.length,
        deleted: deletedCount,
        orphanedMetadataRemoved: orphanedIds.length,
    });
}
