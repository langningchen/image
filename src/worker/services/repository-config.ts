import type { Env } from '../types.ts';
import { commitGithubChanges, GithubApiError } from '../repositories/github.ts';
import { repositoryConfigFiles } from '../repository-config.generated.ts';

export function repositoryConfigFailure(error: unknown, env: Env) {
    let detail = error instanceof Error ? error.message : 'Unknown synchronization error';
    for (const secret of [env.GITHUB_PAT, env.ADMIN_PASSWORD, env.UPLOAD_PASSWORD]) {
        if (secret) detail = detail.split(secret).join('[redacted]');
    }
    detail = detail.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]').slice(0, 1500);
    let hint = '';
    if (error instanceof GithubApiError) {
        if (error.status === 401) hint = 'Check whether GITHUB_PAT has expired or been revoked.';
        else if (/rate limit/i.test(detail)) hint = 'GitHub rate limit reached; retry after the limit resets.';
        else if (/workflow/i.test(detail)) hint = 'Writing workflow files requires Workflows: write for a fine-grained PAT, or the workflow scope for a classic PAT.';
        else if (error.status === 404) hint = 'Check GITHUB_OWNER/GITHUB_REPO, token repository access, and that the default branch exists.';
        else if (error.operation === 'Update default branch') hint = 'Check branch rules and Contents: write access.';
        else if (error.status === 403) hint = 'Check token repository permissions and organization access restrictions.';
    }
    return {
        error: `Could not sync repository configuration. ${detail}${hint ? ` ${hint}` : ''}`,
        ...(error instanceof GithubApiError ? { operation: error.operation, githubStatus: error.status, requestId: error.requestId } : {}),
    };
}

export async function syncRepositoryConfig(env: Env): Promise<{ changed: number }> {
    const encoder = new TextEncoder();
    const files = await Promise.all(repositoryConfigFiles.map(async file => {
        const content = encoder.encode(file.content);
        const header = encoder.encode(`blob ${content.length}\0`);
        const blob = new Uint8Array(header.length + content.length);
        blob.set(header);
        blob.set(content, header.length);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', blob));
        const sha = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        return { ...file, sha };
    }));
    const changed = await commitGithubChanges(env, tree => {
        const existing = new Map(tree.tree?.map(entry => [entry.path, entry]));
        return files.filter(file => {
            const current = existing.get(file.path);
            return current?.sha !== file.sha || current.mode !== file.mode;
        }).map(({ path, mode, content }) => ({ path, mode, type: 'blob', content }));
    }, () => 'Configure daily deleted image history cleanup');
    return { changed };
}
