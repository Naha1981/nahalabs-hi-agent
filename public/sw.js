// HI service worker: network-first, and never hand the browser an undefined
// response. The old version returned caches.match(request) on network failure
// without ever populating the cache, which resolves undefined and surfaces as
// ERR_FAILED for returning users. Navigations now get a real offline page;
// other same-origin GETs get a plain 504.
const OFFLINE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HI - no connection</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#fff;color:#1d1d1f}div{text-align:center;max-width:320px;padding:20px}h1{font-size:22px;margin:0 0 10px}p{color:#6e6e73;line-height:1.5;margin:0}</style></head><body><div><h1>HI by NahaLabs</h1><p>No connection right now. Check your internet and try again - this page reloads when you are back online.</p></div></body></html>';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => new Response('', { status: 504 })));
});
