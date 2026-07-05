// MyLife Hub — service worker (offline shell)
const CACHE = 'mylife-notes-v131';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// cache-first: serve the stored copy instantly, refresh it in the background for next time
function cacheFirst(req) {
  return caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Firebase SDK modules are big and never change for a given version → cache them so
  // they load instantly after the first visit (this used to re-download every launch).
  if (url.hostname === 'www.gstatic.com' && url.pathname.includes('/firebasejs/')) {
    e.respondWith(cacheFirst(e.request));
    return;
  }

  // Never cache live data / map-routing / Telegram traffic — always go to the network.
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebase') || url.hostname.includes('gstatic.com') ||
      url.hostname.includes('openstreetmap.org') || url.hostname.includes('project-osrm.org') || url.hostname.includes('google.com') ||
      url.hostname.includes('komoot.io') || url.hostname.includes('telegram.org')) {
    return;
  }
  if (url.pathname.startsWith('/api')) return; // never cache serverless API calls

  // App shell (html/css/js/icons) → cache-first so the app opens instantly; the background
  // refresh + the page's controllerchange auto-reload pick up new deploys.
  e.respondWith(cacheFirst(e.request));
});
