import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assessImage } from '../src/worker/services/moderation.ts';
import type { Env } from '../src/worker/types.ts';

// Uses the same request, normalization and verdict validation as production.
// Sends only synthetic fixtures to AI: no uploads, database writes or fallback.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to your model-enabled account');
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
    const credentials = await readFile(join(homedir(), '.config/.wrangler/config/default.toml'), 'utf8');
    token = credentials.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
}
if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN or authenticate with wrangler login');

const env = { AI: { run: async (model: string, input: unknown) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(25000),
    });
    const body = await response.json() as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] };
    if (!response.ok || body.success === false) {
        throw new Error(`Workers AI HTTP ${response.status}: ${body.errors?.map(error => `${error.code}: ${error.message}`).join('; ') ?? 'request failed'}`);
    }
    return body.result;
} } } as unknown as Env;

const fixtures = [
    { file: 'landscape.png', expected: { approved: true, reason: 'safe' } },
    { file: 'portrait.png', expected: { approved: true, reason: 'safe' } },
    { file: 'terrorist-propaganda.png', expected: { approved: false, reason: 'hate_extremism' } },
    { file: 'propaganda-injection.png', expected: { approved: false, reason: 'hate_extremism' } },
];
const repeats = Number(process.env.MODERATION_DEBUG_REPEATS ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('MODERATION_DEBUG_REPEATS must be between 1 and 5');
let failures = 0;
for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const fixture of fixtures) {
        const bytes = await readFile(new URL(`../tests/fixtures/moderation/${fixture.file}`, import.meta.url));
        try {
            const assessment = await assessImage(env, `data:image/png;base64,${bytes.toString('base64')}`);
            const pass = assessment.verdict.approved === fixture.expected.approved && assessment.verdict.reason === fixture.expected.reason;
            if (!pass) failures++;
            console.log(JSON.stringify({ fixture: fixture.file, repetition, pass, expected: fixture.expected, ...assessment }));
        } catch (error) {
            failures++;
            console.log(JSON.stringify({ fixture: fixture.file, repetition, pass: false, error: error instanceof Error ? error.message : String(error) }));
        }
    }
}
console.log(JSON.stringify({ total: fixtures.length * repeats, failures }));
process.exitCode = failures ? 1 : 0;
