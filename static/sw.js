// SkypeRTC Service Worker — caches MediaPipe assets so background blur loads instantly after first use.
const CACHE = 'skypertc-mp-v1';

const HOST_ALLOW = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/',
  'https://storage.googleapis.com/mediapipe-models/',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (!HOST_ALLOW.some(p => url.startsWith(p))) return;
  if (e.request.method !== 'GET') return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
        cache.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      // Network failed and nothing in cache — let it bubble up.
      throw err;
    }
  })());
});
