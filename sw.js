// Service Worker for Card Wallet PWA
const CACHE_NAME = 'card-wallet-v5.12.3';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/ai.js',
  './js/auth.js',
  './js/camera.js',
  './js/card-model.js',
  './js/collection.js',
  './js/comps.js',
  './js/db.js',
  './js/ebay-api.js',
  './js/ebay-auth.js',
  './js/ebay-listing.js',
  './js/firebase.js',
  './js/listing.js',
  './js/settings.js',
  './js/scanner.js',
  './js/sync.js',
  './js/ui.js',
  './manifest.json'
];

// Cache app shell on install — use cache:'reload' to bypass HTTP cache
// and ensure fresh files when the service worker version changes
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res))
        )
      )
    )
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for API calls, cache-first for app shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Cache-first for OpenCV CDN (large WASM, rarely changes)
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('opencv')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first for API calls and Firebase
  if (url.hostname === 'api.anthropic.com' ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('workers.dev') ||
      url.hostname.includes('firebasestorage.googleapis.com')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for app shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        // Update cache with fresh version
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetched;
    })
  );
});
