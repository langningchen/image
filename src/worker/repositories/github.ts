import type { Env } from '../types.ts';
import { IMAGE_PATH_PATTERN } from '../constants.ts';
import { retentionMs } from '../config.ts';
const GITHUB_API_VERSION = '2022-11-28';

export interface GithubContentResponse {
    sha?: string;
    content?: {
        name?: string;
    };
}

interface GithubTreeResponse {
    truncated?: boolean;
    tree?: Array<{
        path?: string;
        type?: string;
        sha?: string;
        mode?: string;
    }>;
}

export function githubHeaders(env: Env, accept = 'application/vnd.github+json'): HeadersInit {
    return {
        'Authorization': `Bearer ${env.GITHUB_PAT}`,
        'Accept': accept,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'langningchen-image',
    };
}

export function githubApiUrl(env: Env, path: string): URL {
    return new URL(
        `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}${path}`,
    );
}

export async function listCurrentImages(env: Env): Promise<Map<string, string>> {
    const response = await fetch(githubApiUrl(env, '/git/trees/HEAD?recursive=1'), {
        headers: githubHeaders(env),
    });

    if (!response.ok) {
        throw new Error(`Could not list target repository tree: ${response.status} ${await response.text()}`);
    }

    const treeResponse = await response.json() as GithubTreeResponse;
    if (treeResponse.truncated) {
        throw new Error('Target repository tree is truncated; cleanup stopped to avoid using incomplete data.');
    }

    const imageIds = new Map<string, string>();
    for (const item of treeResponse.tree ?? []) {
        if (item.type === 'blob' && item.path && IMAGE_PATH_PATTERN.test(item.path)) {
            const [id, extension] = item.path.split('.');
            imageIds.set(id, extension);
        }
    }
    return imageIds;
}

export async function deleteImageFromGithub(env: Env, imageId: string, extension = 'jpeg', reason = `after ${retentionMs(env) / 86400000} days without access`): Promise<void> {
    const contentUrl = githubApiUrl(env, `/contents/${imageId}.${extension}`);
    const metadataResponse = await fetch(contentUrl, { headers: githubHeaders(env) });

    if (metadataResponse.status === 404) {
        return;
    }
    if (!metadataResponse.ok) {
        throw new Error(`Could not read ${imageId}.${extension} before deletion: ${metadataResponse.status}`);
    }

    const metadata = await metadataResponse.json() as GithubContentResponse;
    if (!metadata.sha) {
        throw new Error(`GitHub did not return a SHA for ${imageId}.${extension}`);
    }

    const deleteResponse = await fetch(contentUrl, {
        method: 'DELETE',
        headers: {
            ...githubHeaders(env),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message: `Delete ${imageId}.${extension} ${reason}`,
            sha: metadata.sha,
        }),
    });

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Could not delete ${imageId}.${extension}: ${deleteResponse.status} ${await deleteResponse.text()}`);
    }
}

interface GithubTreeChange {
    path: string;
    mode: string;
    type: 'blob';
    sha?: string | null;
    content?: string;
}

/** Publish a single commit; rebuild it if another writer advances the branch. */
export async function commitGithubChanges(
    env: Env,
    changes: (tree: GithubTreeResponse) => GithubTreeChange[],
    message: (count: number) => string,
): Promise<number> {
    async function request<T>(path: string, body?: unknown): Promise<T> {
        const response = await fetch(githubApiUrl(env, path), {
            method: body === undefined ? 'GET' : 'POST',
            headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`GitHub ${path} failed: ${response.status} ${await response.text()}`);
        return await response.json() as T;
    }
    const repository = await request<{ default_branch: string }>('');
    if (!repository.default_branch) throw new Error('GitHub did not return a default branch');
    const branch = repository.default_branch.split('/').map(encodeURIComponent).join('/');
    for (let attempt = 0; attempt < 3; attempt++) {
        const ref = await request<{ object: { sha: string } }>(`/git/ref/heads/${branch}`);
        if (!ref.object?.sha) throw new Error('GitHub did not return the branch SHA');
        const parent = await request<{ tree: { sha: string } }>(`/git/commits/${ref.object.sha}`);
        if (!parent.tree?.sha) throw new Error('GitHub did not return the base tree SHA');
        const currentTree = await request<GithubTreeResponse>(`/git/trees/${parent.tree.sha}?recursive=1`);
        if (currentTree.truncated) throw new Error('Target repository tree is truncated; repository update stopped.');
        const entries = changes(currentTree);
        if (!entries.length) return 0;
        const tree = await request<{ sha: string }>('/git/trees', {
            base_tree: parent.tree.sha,
            tree: entries,
        });
        if (!tree.sha) throw new Error('GitHub did not return the updated tree SHA');
        const commit = await request<{ sha: string }>('/git/commits', {
            message: message(entries.length),
            tree: tree.sha,
            parents: [ref.object.sha],
        });
        if (!commit.sha) throw new Error('GitHub did not return the new commit SHA');
        const updated = await fetch(githubApiUrl(env, `/git/refs/heads/${branch}`), {
            method: 'PATCH',
            headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
            body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        if (updated.ok) return entries.length;
        // Rebuild from the latest tree when another writer advances the branch.
        if ((updated.status === 409 || updated.status === 422) && attempt < 2) continue;
        throw new Error(`Could not publish repository changes: ${updated.status} ${await updated.text()}`);
    }
    throw new Error('Could not publish repository changes after retries');
}

/** Publish all removals together, preserving concurrent uploads on the default branch. */
export async function deleteImagesFromGithub(env: Env, paths: string[], reason: string): Promise<void> {
    if (!paths.length) return;
    await commitGithubChanges(env, tree => {
        const existing = new Set(tree.tree?.filter(item => item.type === 'blob').map(item => item.path));
        return [...new Set(paths)].filter(path => existing.has(path))
            .map(path => ({ path, mode: '100644', type: 'blob', sha: null }));
    }, count => `Delete ${count} inactive images ${reason}`);
}
