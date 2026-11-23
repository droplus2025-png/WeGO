/* sw.js — offline support: the app shell is cached; pages are served from the cache and refreshed in the background.
   Bump CACHE when you publish a new version so old files are dropped. */
const CACHE = 'wego-v1';
const FILES = [
  './', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './logo.png', './wego-logo.png',
  './wego_rules.js', './wego_schema.js', './wego_store.js', './wego_catalog.js', './wego_engine.js', './wego_sale.js',
  './wego_purchase.js', './wego_stock.js', './wego_invoices.js', './wego_debts.js', './wego_cash.js', './wego_admin.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
