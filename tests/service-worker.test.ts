import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
function fixture({ cached, offline = false, writeFailure = false }: { cached?: Response; offline?: boolean; writeFailure?: boolean } = {}) {
  const listeners: Record<string, (event: any) => void> = {};
  let requests = 0;
  let activated = 0, claimed = 0;
  const writes: string[] = [];
  const cache = {
    addAll: async () => {},
    match: async () => cached,
    put: async (request: Request) => { if (writeFailure) throw new Error('Cache full'); writes.push(request.url); },
  };
  runInNewContext(source, {
    self: { skipWaiting: async () => { activated++; }, clients: { claim: async () => { claimed++; } }, location: new URL('https://image.test/'), addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback; } },
    caches: { open: async () => cache, keys: async () => [] }, URL, Response,
    fetch: async () => { requests++; if (offline) throw new TypeError('Failed to fetch'); return new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }); },
  });
  function dispatch(path: string, method = 'GET') {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    listeners.fetch({ request: new Request(new URL(path, 'https://image.test'), { method }), respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: (value: Promise<unknown>) => pending.push(value) });
    return { get response() { return response; }, pending };
  }
  async function lifecycle(name: string) {
    const pending: Promise<unknown>[] = [];
    listeners[name]({ waitUntil: (value: Promise<unknown>) => pending.push(value) });
    await Promise.all(pending);
  }
  return { dispatch, writes, requests: () => requests, lifecycle, activated: () => activated, claimed: () => claimed };
}

test('service worker does not intercept admin, API, third-party or upload requests', () => {
  const { dispatch, requests } = fixture();
  for (const path of ['/admin/', '/api/admin/images', '/assets/admin.js', '/cdn-cgi/zaraz/s.js', 'https://static.cloudflareinsights.com/beacon.js', `https://other.test/${'a'.repeat(32)}`]) {
    assert.equal(dispatch(path).response, undefined, path);
  }
  assert.equal(dispatch('/upload', 'POST').response, undefined);
  assert.equal(requests(), 0);
});

test('cached public page survives offline revalidation without a rejected promise', async () => {
  const { dispatch } = fixture({ cached: new Response('cached page'), offline: true });
  const event = dispatch('/');
  assert.equal(await (await event.response!).text(), 'cached page');
  await Promise.all(event.pending);
});

test('immutable image caching stays cache-first and handles offline misses', async () => {
  const path = `/${'a'.repeat(32)}?search`;
  const hit = fixture({ cached: new Response('cached image'), offline: true });
  assert.equal(await (await hit.dispatch(path).response!).text(), 'cached image');
  assert.equal(hit.requests(), 0);
  const miss = fixture({ offline: true });
  assert.equal((await miss.dispatch(path).response!).status, 503);
});

test('cache write failures do not reject successful image responses', async () => {
  const { dispatch } = fixture({ writeFailure: true });
  const event = dispatch(`/${'b'.repeat(32)}`);
  assert.equal((await event.response!).status, 200);
  await Promise.all(event.pending);
});


test('updated service worker activates and claims existing clients', async () => {
  const worker = fixture();
  await worker.lifecycle('install');
  assert.equal(worker.activated(), 1);
  await worker.lifecycle('activate');
  assert.equal(worker.claimed(), 1);
});
