import type { Env } from '../types.ts';
import { claimDeletion, releaseDeletion, recoverDeletionClaims } from '../repositories/management.ts';
import { retentionMs } from '../config.ts';
import { listCurrentImages, deleteImagesFromGithub, repositoryFailure } from '../repositories/github.ts';
import { listAccessTimes, getAccessTime, initializeAccess, removeAccess, removeAccessBatch } from '../repositories/access.ts';
const BATCH_SIZE = 100;

export interface CleanupResult {
    tracked: number;
    initialized: number;
    deleted: number;
    failed: number;
    failures: string[];
    orphanedMetadataRemoved: number;
}

export async function cleanupInactiveImages(env: Env, now: number): Promise<CleanupResult> {
    await recoverDeletionClaims(env, now);
    const currentImages = await listCurrentImages(env);
    const accessTimes = await listAccessTimes(env);
    const cutoff = now - retentionMs(env);

    // Give images uploaded before this feature a full retention period from the first
    // cleanup run instead of deleting them without a known last-access time.
    const missingIds = [...currentImages.keys()].filter((imageId) => !accessTimes.has(imageId));
    for (let index = 0; index < missingIds.length; index += BATCH_SIZE) {
        await initializeAccess(env, missingIds.slice(index, index + BATCH_SIZE), now);
    }

    const staleIds = [...accessTimes]
        .filter(([imageId, lastAccessedAt]) => currentImages.has(imageId) && lastAccessedAt <= cutoff)
        .map(([imageId]) => imageId);

    let deletedCount = 0;
    let failedCount = 0;
    const failures: string[] = [];
    const claimedIds: string[] = [];
    for (const imageId of staleIds) {
        try {
            // Re-read immediately before deletion to reduce the chance that a
            // concurrent real view loses a just-renewed image.
            const latestAccess = await getAccessTime(env, imageId);
            if (latestAccess === null || latestAccess > cutoff) {
                continue;
            }

            if (!(await claimDeletion(env, imageId, cutoff))) continue;
            claimedIds.push(imageId);
        } catch (error) {
            await releaseDeletion(env, imageId);
            failedCount += 1;
            const details = repositoryFailure(error, env, 'delete expired images');
            failures.push(details.error);
            console.error('Image deletion failed:', imageId, details);
        }
    }

    if (claimedIds.length) {
        let published = false;
        try {
            await deleteImagesFromGithub(env, claimedIds.map(id => `${id}.${currentImages.get(id)}`),
                `after ${retentionMs(env) / 86400000} days without access`);
            published = true;
            for (const imageId of claimedIds) {
                await removeAccess(env, imageId);
                deletedCount += 1;
            }
        } catch (error) {
            // Keep claims if GitHub succeeded but metadata cleanup failed;
            // reconciliation will remove that metadata on the next run.
            if (!published) {
                for (const imageId of claimedIds) await releaseDeletion(env, imageId);
            }
            failedCount += claimedIds.length - deletedCount;
            const details = repositoryFailure(error, env, 'delete expired images');
            failures.push(details.error);
            console.error('Batch image deletion failed:', details);
        }
    }

    const orphanedIds = [...accessTimes.keys()].filter((imageId) => !currentImages.has(imageId));
    for (let index = 0; index < orphanedIds.length; index += BATCH_SIZE) {
        await removeAccessBatch(env, orphanedIds.slice(index, index + BATCH_SIZE), now);
    }

    const result: CleanupResult = {
        tracked: accessTimes.size + missingIds.length,
        initialized: missingIds.length,
        deleted: deletedCount,
        failed: failedCount,
        failures,
        orphanedMetadataRemoved: orphanedIds.length,
    };
    console.log('Image cleanup complete', result);
    return result;
}
