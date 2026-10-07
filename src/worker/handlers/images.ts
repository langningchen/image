import type { Env } from '../types.ts';
import { IMAGE_ID_PATTERN, corsHeaders } from '../constants.ts';
import { githubApiUrl, githubHeaders, type GithubContentResponse } from '../repositories/github.ts';
import { recordAccess } from '../repositories/access.ts';

function imageResponseHeaders(imageId: string): HeadersInit {
    return {
        'Content-Type': 'image/jpeg',
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

export async function handleUpload(request: Request, env: Env): Promise<Response> {
    const image = await request.text();
    let imageId = '';
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        imageId += String.fromCharCode(byte % 26 + 97);
    }

    const imageData = image.replace(/^data:image\/[^;]+;base64,/, '');
    if (!imageData) {
        return new Response('Invalid image data', {
            status: 400,
            headers: corsHeaders,
        });
    }

    try {
        const response = await fetch(githubApiUrl(env, `/contents/${imageId}.jpeg`), {
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
        if (jsonResponse.content?.name !== `${imageId}.jpeg`) {
            console.error('Unexpected upload response:', jsonResponse);
            return new Response('Upload failed', {
                status: 500,
                headers: corsHeaders,
            });
        }

        try {
            await recordAccess(env, imageId);
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

    const headers = imageResponseHeaders(imageId);

    try {
        const githubResponse = await fetch(githubApiUrl(env, `/contents/${imageId}.jpeg`), {
            method: 'GET',
            headers: githubHeaders(env, 'application/vnd.github.raw+json'),
        });

        if (!githubResponse.ok) {
            return new Response('Image not found', { status: 404, headers: corsHeaders });
        }

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
