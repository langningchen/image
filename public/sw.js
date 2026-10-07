// Service Worker for aggressive caching of static assets and images
const CACHE_NAME = 'image-host-v1';
const STATIC_CACHE = 'static-v2';

// Files to cache immediately
const STATIC_ASSETS = [
    '/',
    '/index.html'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(STATIC_ASSETS))
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Cache images aggressively since they never change
    if (event.request.method === 'GET' && url.pathname.match(/^\/[a-z]{32}$/)) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache => {
                return cache.match(event.request).then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    
                    return fetch(event.request).then(response => {
                        // Cache successful image responses
                        if (response.ok && response.headers.get('content-type')?.includes('image')) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    });
                });
            })
        );
        return;
    }
    
    // Cache static assets with stale-while-revalidate strategy
    if (event.request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache => {
                return cache.match(event.request).then(cachedResponse => {
                    const fetchPromise = fetch(event.request).then(response => {
                        if (response.ok) {
                            cache.put(event.request, response.clone());
                        }
                        return response;
                    });
                    
                    // Return cached version immediately, update in background
                    return cachedResponse || fetchPromise;
                });
            })
        );
        return;
    }
    
    // Let all other requests pass through
    event.respondWith(fetch(event.request));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME && cacheName !== STATIC_CACHE) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});