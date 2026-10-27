/* Static files only. Bump CACHE when one of them changes; activate drops older caches.
   Do not add API routes or HTML pages to this list. Those must stay on the network. */
const CACHE = 'tgb-static-v1';
const ASSETS = [
  '/static/app.css',
  '/static/common.js',
  '/static/logo.png',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/icon-maskable-192.png',
  '/static/icon-maskable-512.png',
  '/static/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate' || !url.pathname.startsWith('/static/')) {
    event.respondWith(fetch(req).catch(() => new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · TGB Dashboard</title><body style="margin:0;min-height:100vh;background:#0B1F3A;color:#fff;font-family:sans-serif;padding:28px"><h1>You are offline</h1><p>Open the app again when you have a connection. Numbers are not stored on this phone.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
    )));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) return hit;
    const res = await network;
    return res || new Response('', { status: 504, headers: { 'Cache-Control': 'no-store' } });
  })());
});
