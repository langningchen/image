import type { Env } from './types.ts';
import { trackResponse, pruneActivity } from './repositories/traffic.ts';
import { handleAdmin } from './handlers/admin.ts';
import { corsHeaders, IMAGE_ID_PATTERN } from './constants.ts';
import { handleUpload, handleImageRequest } from './handlers/images.ts';
import { cleanupInactiveImages } from './services/cleanup.ts';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (new URL(request.url).pathname.startsWith('/api/admin/')) return handleAdmin(request, env);
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders,
            });
        }

        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/upload') {
            const metrics = { bytes: 0 };
            const response = await handleUpload(request, env, metrics);
            return trackResponse(request, response, env, ctx, metrics.bytes);
        }
        if (request.method === 'GET') {
            const response = await handleImageRequest(request, env, ctx);
            if (IMAGE_ID_PATTERN.test(url.pathname.slice(1))) return trackResponse(request, response, env, ctx);
            return response;
        }
        return new Response('404', { status: 404 });
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil((async () => {
            await pruneActivity(env, controller.scheduledTime);
            await cleanupInactiveImages(env, controller.scheduledTime);
        })().catch((error) => {
            console.error('Scheduled cleanup failed:', error);
            throw error;
        }));
    },
} satisfies ExportedHandler<Env>;
