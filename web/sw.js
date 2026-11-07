// Service worker: caches the app shell + libraries so the survey form opens without network.
// Bump VERSION whenever you deploy changes to force phones to pick up the new files.
const VERSION = 'v1';
const CACHE = 'line-survey-' + VERSION;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/catalog.js', 'js/config.js', 'js/dashboard.js', 'js/db.js',
  'js/editor.js', 'js/filters.js', 'js/i18n.js', 'js/masters.js', 'js/pdf-stretch.js', 'js/pdfutil.js', 'js/report.js', 'js/survey.js', 'js/util.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('line-survey-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return;               // never cache API calls
  if (url.hostname.endsWith('tile.openstreetmap.org')) return;
  // network-first for our own files (fresh deploys), cache-first for CDN libs
  if (url.origin === location.origin) {
    // 'no-cache' = always check with the server (cheap 304 when unchanged), so a deploy never leaves a mix of old and new files
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
