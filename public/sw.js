// Cache immutable images and the public upload page only.
const CACHE_NAME = 'image-host-v1';
const STATIC_CACHE = 'static-v2';
const STATIC_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

async function fetchAndCache(request, cache, event) {
    let response;
    try {
        response = await fetch(request);
    } catch {
        return new Response('Network unavailable', { status: 503 });
    }
    const isImage = /^\/[0-9a-z]{32}$/.test(new URL(request.url).pathname);
    if (response.ok && (!isImage || response.headers.get('content-type')?.includes('image'))) {
        // A cache write failure must not discard a successful network response.
        event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
    const isImage = /^\/[0-9a-z]{32}$/.test(url.pathname);
    const isPublicPage = STATIC_ASSETS.includes(url.pathname);
    // Administration, APIs, scripts and third-party requests use the browser network directly.
    if (!isImage && !isPublicPage) return;
    event.respondWith((async () => {
        const cache = await caches.open(isImage ? CACHE_NAME : STATIC_CACHE);
        const cached = await cache.match(event.request);
        if (isImage && cached) return cached;
        const network = fetchAndCache(event.request, cache, event);
        if (cached) {
            event.waitUntil(network.then(() => {}));
            return cached;
        }
        return network;
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then(cacheNames => Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME && name !== STATIC_CACHE).map(name => caches.delete(name)),
    )).then(() => self.clients.claim()));
});
