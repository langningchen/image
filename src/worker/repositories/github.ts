import type { Env } from '../types.ts';
import { IMAGE_PATH_PATTERN } from '../constants.ts';
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
    }>;
}

export function githubHeaders(env: Env, accept = 'application/vnd.github+json'): HeadersInit {
    return {
        'Authorization': `Bearer ${env.GithubPAT}`,
        'Accept': accept,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'langningchen-image',
    };
}

export function githubApiUrl(env: Env, path: string): URL {
    return new URL(
        `https://api.github.com/repos/${encodeURIComponent(env.GithubOwner)}/${encodeURIComponent(env.GithubRepo)}${path}`,
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

export async function deleteImageFromGithub(env: Env, imageId: string, extension = 'jpeg'): Promise<void> {
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
            message: `Delete ${imageId}.${extension} after 7 days without access`,
            sha: metadata.sha,
        }),
    });

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Could not delete ${imageId}.${extension}: ${deleteResponse.status} ${await deleteResponse.text()}`);
    }
}
