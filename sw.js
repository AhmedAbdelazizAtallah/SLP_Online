// SLP Next service worker v2 - resilient app-shell caching.
// JS/vendor assets use stale-while-revalidate so deploys always win by next load;
// navigation is network-first; API/WS traffic is never cached.
const CACHE = 'slp-next-v4';
const SHELL = [
  './',
  './app.compiled.js',
  './manifest.json',
  './vendor/react.js',
  './vendor/react-dom.js',
  './vendor/three.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

const NEVER = ['/predict', '/ws', '/health', '/models', '/api/'];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;                 // fonts/CDN pass through
  if (e.request.method !== 'GET') return;
  if (NEVER.some((p) => url.pathname === p || url.pathname.startsWith(p))) return;

  // Navigation: network-first, cache fallback (keeps every deploy fresh)
  if (e.request.mode === 'navigate' || url.pathname === '/' ) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put('./', cp)).catch(() => {});
        return r;
      }).catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || Response.error()))
    );
    return;
  }

  // Same-origin assets: serve fast from cache, refresh in background (SWR)
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const net = fetch(e.request).then((r) => {
          if (r && r.ok && r.type === 'basic') {
            const cp = r.clone();
            cache.put(e.request, cp).catch(() => {});
          }
          return r;
        }).catch(() => hit || Response.error());
        return hit || net;
      })
    )
  );
});