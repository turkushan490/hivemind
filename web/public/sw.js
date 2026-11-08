// HiveMind as an installable app: pages always come from the server; only when it can't be reached does the
// offline page show. Nothing else is cached, so an update is never stuck behind an old copy.
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('hivemind-offline').then((c) => c.addAll([OFFLINE, '/icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
