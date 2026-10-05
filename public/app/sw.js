// Minimal service worker so the dashboard can be installed as an app.
// It deliberately caches NOTHING: account pages and API responses must always come live from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));
