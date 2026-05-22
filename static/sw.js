// SkypeRTC Service Worker — app-shell precache + MediaPipe asset cache.
// SHELL: bump version on each release to invalidate clients.
const SHELL = 'skypertc-shell-v6';
const MP    = 'skypertc-mp-v1';

const SHELL_PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icons.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/icon.svg',
];

const MP_ALLOW = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/',
  'https://storage.googleapis.com/mediapipe-models/',
];

// Pathnames that must always hit the network (signalling, runtime config, healthcheck).
const NETWORK_ONLY = new Set(['/ws', '/config.json', '/healthz']);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll fails atomically if any URL 404s — fall back to per-URL adds.
    try { await cache.addAll(SHELL_PRECACHE); }
    catch {
      await Promise.all(SHELL_PRECACHE.map(u => cache.add(u).catch(() => {})));
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== MP).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && NETWORK_ONLY.has(url.pathname)) return;

  // MediaPipe CDN — cache-first.
  if (MP_ALLOW.some(p => req.url.startsWith(p))) {
    e.respondWith((async () => {
      const cache = await caches.open(MP);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        cache.put(req, res.clone());
      }
      return res;
    })());
    return;
  }

  // Same-origin assets — stale-while-revalidate with navigation fallback.
  if (sameOrigin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (cached) {
        network.catch(() => {});
        return cached;
      }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const idx = (await cache.match('/index.html')) || (await cache.match('/'));
        if (idx) return idx;
      }
      return Response.error();
    })());
  }
});
