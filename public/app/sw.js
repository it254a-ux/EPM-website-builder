// Makes the dashboard open instantly and lets it be installed as an app.
//   - Its own files (page, script, styles, icons) are served from the device at once, then quietly refreshed.
//     When a newer script is found the page is told, and it reloads on your next click (never while you are typing).
//   - Account data (/api/...) is NEVER stored here: it always comes live from the server.
const CACHE = 'epm-app-v6';
const SHELL = ['/app/index.html', '/app/owner.js?v=6', '/app/owner.css?v=6', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const sig = r => (r && (r.headers.get('etag') || r.headers.get('last-modified'))) || '';

async function refresh(key, request, cached) {
    try {
        const fresh = await fetch(request, { cache: 'no-cache' });
        if (!fresh || fresh.status !== 200 || fresh.type !== 'basic') return null;
        const changed = cached && sig(cached) && sig(fresh) && sig(cached) !== sig(fresh);
        await (await caches.open(CACHE)).put(key, fresh.clone());
        if (changed) (await self.clients.matchAll()).forEach(c => c.postMessage({ type: 'epm-updated' }));
        return fresh;
    } catch (e) { return null; }
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/app')) return; // other pages and every /api/ call go straight to the network
    if (url.pathname === '/app/sw.js') return;
    // Every visit to the dashboard page is the same file, so they share one stored copy.
    const isPage = req.mode === 'navigate';
    const key = isPage ? '/app/index.html' : req.url;
    event.respondWith((async () => {
        const cached = await (await caches.open(CACHE)).match(key);
        if (cached) { event.waitUntil(refresh(key, isPage ? key : req, cached)); return cached; }
        const fresh = await refresh(key, isPage ? key : req, null);
        return fresh || fetch(req);
    })());
});
