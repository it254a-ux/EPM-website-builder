// The dashboard's service worker: its own files come from the device at once, account data never does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// The worker's current cache name, read from the file so a version bump never breaks this test.
const CURRENT_CACHE = require('fs').readFileSync(require('path').join(__dirname, '../../public/app/sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1];

function load() {
    const store = new Map(), handlers = {}, messages = [], network = [];
    let version = 'v1', down = false;
    const mkResponse = (url, body, etag) => ({ status: 200, type: 'basic', url, body, headers: { get: k => (k.toLowerCase() === 'etag' ? etag : null) }, clone() { return this; } });
    const cache = { match: async k => store.get(String(k)) || null, put: async (k, r) => { store.set(String(k), r); }, add: async u => { store.set(u, mkResponse(u, 'x', 'e-' + version)); } };
    const self = {
        location: { origin: 'https://b.test' },
        addEventListener: (t, f) => { handlers[t] = f; },
        skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: m => messages.push(m) }] },
    };
    const ctx = {
        self, URL, Promise,
        caches: { open: async () => cache, keys: async () => ['old-cache', CURRENT_CACHE], delete: async k => { store.set('deleted:' + k, true); } },
        fetch: async (r, o) => { if (down) throw new Error('offline'); const url = typeof r === 'string' ? new URL(r, 'https://b.test').href : r.url; network.push(url); return mkResponse(url, 'body-' + version, 'e-' + version); },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/app/sw.js'), 'utf8'), ctx);
    const run = (url, { method = 'GET', mode = 'cors' } = {}) => new Promise(resolve => {
        const waits = [];
        let answered = false;
        handlers.fetch({ request: { url, method, mode }, respondWith: p => { answered = true; resolve(Promise.resolve(p).then(async r => { await Promise.all(waits); return r; })); }, waitUntil: p => waits.push(p) });
        if (!answered) resolve(undefined);
    });
    return { run, store, messages, network, setVersion: v => { version = v; }, setDown: d => { down = d; }, handlers };
}

test('files are fetched once, then served from the device while a fresh copy is fetched quietly', async () => {
    const sw = load();
    const first = await sw.run('https://b.test/app/owner.js');
    assert.equal(first.body, 'body-v1');
    assert.equal(sw.network.length, 1);
    const second = await sw.run('https://b.test/app/owner.js');
    assert.equal(second.body, 'body-v1', 'answered from the stored copy');
    assert.equal(sw.network.length, 2, 'and refreshed in the background');
    assert.deepEqual(sw.messages, []);
});

test('when a newer file is found the page is told', async () => {
    const sw = load();
    await sw.run('https://b.test/app/owner.js');
    sw.setVersion('v2');
    const r = await sw.run('https://b.test/app/owner.js');
    assert.equal(r.body, 'body-v1', 'this visit still opens instantly');
    assert.deepEqual(JSON.parse(JSON.stringify(sw.messages)), [{ type: 'epm-updated' }]);
    assert.equal((await sw.run('https://b.test/app/owner.js')).body, 'body-v2', 'the next visit has the new file');
});

test('every visit to the dashboard page shares one stored copy, whatever the address', async () => {
    const sw = load();
    await sw.run('https://b.test/app?google=error', { mode: 'navigate' });
    const again = await sw.run('https://b.test/app/#/bots', { mode: 'navigate' });
    assert.equal(again.body, 'body-v1');
    assert.ok(sw.store.has('/app/index.html'));
});

test('account data, other pages, other sites and non-GET calls are never touched', async () => {
    const sw = load();
    for (const [url, opts] of [
        ['https://b.test/api/commissions', {}], ['https://b.test/api/bootstrap', {}], ['https://b.test/admin/admin.js', {}],
        ['https://b.test/', {}], ['https://evil.test/app/owner.js', {}], ['https://b.test/app/owner.js', { method: 'POST' }], ['https://b.test/app/sw.js', {}],
    ]) assert.equal(await sw.run(url, opts), undefined, url);
    assert.equal(sw.network.length, 0);
});

test('a failed refresh never breaks a page that is already stored', async () => {
    const sw = load();
    await sw.run('https://b.test/app/owner.css');
    sw.setDown(true);                                   // no connection at all
    const r = await sw.run('https://b.test/app/owner.css');
    assert.equal(r.body, 'body-v1', 'the stored copy still opens');
    assert.deepEqual(sw.messages, []);
});

test('old stored copies are cleared when a new version takes over', async () => {
    const sw = load();
    await new Promise(r => sw.handlers.activate({ waitUntil: p => p.then(r) }));
    assert.ok(sw.store.get('deleted:old-cache'));
    assert.ok(!sw.store.get('deleted:' + CURRENT_CACHE), 'the current version is kept');
});
