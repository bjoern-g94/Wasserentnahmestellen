// Service Worker: macht die App offline nutzbar.
// Bei Änderungen an den App-Dateien die Versionsnummer erhöhen.
const APP_CACHE = 'wk-app-v7';
const TILE_CACHE = 'wk-tiles-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './addresses.json',
  './mapdata.json',
  './stellen.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wk-app-') && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Kartenkacheln: erst Cache, sonst Netz (und dabei mitspeichern)
  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(req.url);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) cache.put(req.url, res.clone());
          return res;
        } catch (e) {
          return Response.error();
        }
      })
    );
    return;
  }

  // Grundbestand der Entnahmestellen: erst Netz (damit Updates sofort ankommen), sonst Cache
  if (url.origin === self.location.origin && url.pathname.endsWith('/stellen.json')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) { const c = res.clone(); caches.open(APP_CACHE).then((cc) => cc.put(req, c)); }
          return res;
        })
        .catch(() => caches.open(APP_CACHE).then((cc) => cc.match(req, { ignoreSearch: true })).then((hit) => hit || Response.error()))
    );
    return;
  }

  // App-Dateien: sofort aus dem Cache, im Hintergrund aktualisieren
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(APP_CACHE).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        const net = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        if (hit) { event.waitUntil(net); return hit; }
        const res = await net;
        if (res) return res;
        if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        return Response.error();
      })
    );
  }
});
