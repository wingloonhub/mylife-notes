// MyLife Hub — service worker (offline shell)
const CACHE = 'mylife-notes-v45';
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache Firebase / Google / map-routing API traffic.
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('firebase') || url.hostname.includes('gstatic.com') ||
      url.hostname.includes('openstreetmap.org') || url.hostname.includes('project-osrm.org') || url.hostname.includes('google.com') ||
      url.hostname.includes('telegram.org')) {
    return;
  }
  if (url.pathname.startsWith('/api')) return; // never cache serverless API calls
  if (e.request.method !== 'GET') return;
  // Network-first: always show the latest when online; fall back to cache offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
