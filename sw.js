/*
 * MPS Silks Inventory Datasheet - Service Worker (v3).
 * Caches app shell for offline use and falls back gracefully.
 */
const CACHE_NAME = 'mps-silks-shell-v3';
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/core.js',
  './js/api.js',
  './js/app.js',
  './assets/mps-logo.png',
  './assets/cb-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch((err) => {
        console.warn('Service worker asset caching issue:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Network-only for API requests, GAS scripts, or POSTs
  if (req.method !== 'GET' || url.pathname.startsWith('/api') || url.hostname.includes('script.google.com') || url.hostname.includes('googleapis.com')) {
    return;
  }

  // App shell: Cache-first with network background fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return networkRes;
      }).catch(() => {
        // Return cached or nothing
        return cached;
      });

      return cached || fetchPromise;
    })
  );
});
