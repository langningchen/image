import type { Env } from './types.ts';
import { corsHeaders } from './constants.ts';
import { handleUpload, handleImageRequest } from './handlers/images.ts';
import { cleanupInactiveImages } from './services/cleanup.ts';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders,
            });
        }

        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/upload') {
            return handleUpload(request, env);
        }
        if (request.method === 'GET') {
            return handleImageRequest(request, env, ctx);
        }
        return new Response('404', { status: 404 });
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(cleanupInactiveImages(env, controller.scheduledTime).catch((error) => {
            console.error('Scheduled cleanup failed:', error);
            throw error;
        }));
    },
} satisfies ExportedHandler<Env>;
