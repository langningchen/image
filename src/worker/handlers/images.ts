import type { Env } from '../types.ts';
import { IMAGE_ID_PATTERN, corsHeaders } from '../constants.ts';
import { githubApiUrl, githubHeaders, type GithubContentResponse } from '../repositories/github.ts';
import { moderateImage } from '../services/moderation.ts';
import { clientIp, getIpControl, recordViolation, WARNING_THRESHOLD } from '../repositories/ip-controls.ts';
import { saveModeration } from '../repositories/management.ts';
import { recordAccess } from '../repositories/access.ts';
import { CONSENT_HEADER, TERMS_VERSION } from '../../terms.ts';

function imageResponseHeaders(imageId: string, extension: string): HeadersInit {
    return {
        'Content-Type': `image/${extension}`,
        // Deliberately keep the original long-lived cache. Only requests that
        // actually reach this Worker renew the seven-day inactivity timer.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"${imageId}"`,
        'Last-Modified': new Date().toUTCString(),
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders,
    };
}

export async function handleUpload(request: Request, env: Env, metrics = { bytes: 0 }): Promise<Response> {
    const failure = (message: string, status: number) => new Response(message, { status, headers: corsHeaders });
    if (request.headers.get(CONSENT_HEADER) !== TERMS_VERSION) {
        return failure('Please read and accept the current Terms of Service at /terms.html before uploading.', 428);
    }
    const ip = clientIp(request);
    let control;
    try { control = await getIpControl(env, ip); } catch { return failure('Upload temporarily unavailable', 503); }
    if (control && control.banned_until > Date.now()) return failure('Uploads are temporarily suspended. Please try again later.', 403);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    if (reader) {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            metrics.bytes += value.byteLength;
            if (metrics.bytes > 10 * 1024 * 1024) {
                await reader.cancel();
                return failure('Image too large', 413);
            }
            chunks.push(value);
        }
    }
    const buffer = new Uint8Array(metrics.bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const image = new TextDecoder().decode(buffer);
    const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length % 4 !== 0) return failure('Invalid image data', 400);
    let verdict = { approved: true, reason: 'exempt' };
    if (!control?.exempt) {
        try { verdict = await moderateImage(env, image); } catch (error) {
            console.error('Image assessment failed:', error);
            return failure('Upload temporarily unavailable', 503);
        }
        if (!verdict.approved) {
            try {
                const violation = await recordViolation(env, ip, verdict.reason);
                if (violation.banned_until > Date.now()) return failure('Uploads are temporarily suspended. Please try again later.', 403);
                return failure(violation.violations >= WARNING_THRESHOLD ? 'Warning: Do not upload prohibited content. Further violations will suspend uploads.' : 'Upload not allowed', 400);
            } catch { return failure('Upload temporarily unavailable', 503); }
        }
    }
    // Recheck after inference in case another upload or the administrator banned this IP.
    try {
        const latest = await getIpControl(env, ip);
        if (latest && latest.banned_until > Date.now()) return failure('Uploads are temporarily suspended. Please try again later.', 403);
    } catch { return failure('Upload temporarily unavailable', 503); }
    let imageId = '';
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        imageId += String.fromCharCode(byte % 26 + 97);
    }

    const extension = match[1].slice('image/'.length);
    const imageData = match[2];
    if (!imageData) {
        return new Response('Invalid image data', {
            status: 400,
            headers: corsHeaders,
        });
    }

    try {
        const response = await fetch(githubApiUrl(env, `/contents/${imageId}.${extension}`), {
            method: 'PUT',
            headers: {
                ...githubHeaders(env),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: `Upload from ${request.headers.get('CF-Connecting-IP')} ${request.cf?.country}/${request.cf?.city}`,
                content: imageData,
            }),
        });

        if (!response.ok) {
            console.error('GitHub API error:', response.status, await response.text());
            return new Response('Upload failed', {
                status: 500,
                headers: corsHeaders,
            });
        }

        const jsonResponse = await response.json() as GithubContentResponse;
        if (jsonResponse.content?.name !== `${imageId}.${extension}`) {
            console.error('Unexpected upload response:', jsonResponse);
            return new Response('Upload failed', {
                status: 500,
                headers: corsHeaders,
            });
        }

        try {
            await recordAccess(env, imageId);
            await saveModeration(env, imageId, 'approved', verdict.reason);
        } catch (error) {
            // The daily reconciliation initializes missing records, so do not make a
            // successful GitHub upload look like a failure if D1 is temporarily down.
            console.error('Could not initialize image access time:', imageId, error);
        }

        return new Response(imageId, {
            headers: {
                'Content-Type': 'text/plain',
                ...corsHeaders,
            },
        });
    } catch (error) {
        console.error('Upload error:', error);
        return new Response('Upload failed', {
            status: 500,
            headers: corsHeaders,
        });
    }
}

export async function handleImageRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const imageId = url.pathname.substring(1);
    if (!IMAGE_ID_PATTERN.test(imageId)) {
        return new Response('Image not found', { status: 404, headers: corsHeaders });
    }

    try {
        let extension = 'jpeg';
        let githubResponse: Response | undefined;
        for (const candidate of ['jpeg', 'png', 'webp']) {
            extension = candidate;
            githubResponse = await fetch(githubApiUrl(env, `/contents/${imageId}.${extension}`), {
                method: 'GET',
                headers: githubHeaders(env, 'application/vnd.github.raw+json'),
            });
            if (githubResponse.status !== 404) break;
            await githubResponse.body?.cancel();
        }

        if (!githubResponse?.ok) {
            return new Response('Image not found', { status: 404, headers: corsHeaders });
        }

        const headers = imageResponseHeaders(imageId, extension);

        // `?search` is used only by the uploader's local gallery preview and must
        // not extend the lifetime of an image.
        if (!url.searchParams.has('search')) {
            ctx.waitUntil(recordAccess(env, imageId).catch((error) => {
                console.error('Could not record image access:', imageId, error);
            }));
        }

        if (request.headers.get('If-None-Match') === `"${imageId}"`) {
            await githubResponse.body?.cancel();
            return new Response(null, { status: 304, headers });
        }
        return new Response(githubResponse.body, { headers });
    } catch (error) {
        console.error('Image fetch error:', imageId, error);
        return new Response('Image not found', { status: 404, headers: corsHeaders });
    }
}
