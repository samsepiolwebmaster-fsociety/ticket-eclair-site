/* Ticket éclair — service worker : l'appli s'ouvre même sans réseau. Ne voit passer aucune donnée de ticket. */
const VERSION = 'te-v1.1';
const SHELL = ['./', './index.html', './assets/css/style.css', './assets/js/scan.js', './assets/js/app.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u =>
    c.add(new Request(u, u.startsWith('http') ? { mode: 'cors' } : {})).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  const local = url.origin === location.origin;
  const cdn = /^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname);
  if (!local && !cdn) return;
  // fichiers de l'appli : réseau d'abord (mises à jour), cache si hors ligne · CDN : cache d'abord
  e.respondWith(local
    ? fetch(r, { cache: 'no-cache' }).then(res => { const c = res.clone(); caches.open(VERSION).then(k => k.put(r, c)); return res; }).catch(() => caches.match(r, { ignoreSearch: true }))
    : caches.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(VERSION).then(k => k.put(r, c)); } return res; })));
});
