import type { Env } from '../types.ts';
import { recoverDeletionClaims } from '../repositories/management.ts';
import { retentionMs } from '../config.ts';
import { listCurrentImages, deleteImagesFromGithub, repositoryFailure } from '../repositories/github.ts';
import { prepareImageCleanup, finishImageCleanup, removeOrphanedImageAccess } from '../repositories/cleanup.ts';

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
    const cutoff = now - retentionMs(env);
    const currentIds = [...currentImages.keys()];
    const { tracked, initialized, claimedIds } = await prepareImageCleanup(env, currentIds, now, cutoff);

    let deletedCount = 0;
    let failedCount = 0;
    const failures: string[] = [];

    if (claimedIds.length) {
        let published = false;
        try {
            await deleteImagesFromGithub(env, claimedIds.map(id => `${id}.${currentImages.get(id)}`),
                `after ${retentionMs(env) / 86400000} days without access`);
            published = true;
            await finishImageCleanup(env, claimedIds, true);
            deletedCount = claimedIds.length;
        } catch (error) {
            // Keep claims if GitHub succeeded but metadata cleanup failed;
            // reconciliation will remove that metadata on the next run.
            if (!published) {
                await finishImageCleanup(env, claimedIds, false);
            }
            failedCount += claimedIds.length - deletedCount;
            const details = repositoryFailure(error, env, 'delete expired images');
            failures.push(details.error);
            console.error('Batch image deletion failed:', details);
        }
    }

    const orphanedMetadataRemoved = await removeOrphanedImageAccess(env, currentIds, now);

    const result: CleanupResult = {
        tracked,
        initialized,
        deleted: deletedCount,
        failed: failedCount,
        failures,
        orphanedMetadataRemoved,
    };
    console.log('Image cleanup complete', result);
    return result;
}
