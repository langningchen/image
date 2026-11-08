import type { Env } from '../types.ts';
import { commitGithubChanges } from '../repositories/github.ts';
import { repositoryConfigFiles } from '../repository-config.generated.ts';

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
