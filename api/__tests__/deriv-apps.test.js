// Automatic Deriv app creation. Real handlers + real SQL (in-memory Postgres); Deriv is replaced by a fake,
// and the real socket code is also run against a local WebSocket server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { WebSocketServer } = require('ws');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const mySite = require('../my-site');
const admin = require('../admin');
const A = require('../_lib/auth');
const deriv = require('../_lib/deriv-apps');
const { provisionApp } = require('../_lib/site-app');

const HOST = 'builder.test';
const TOKEN = 'SECRET-ADMIN-TOKEN-123';

async function freshDb() {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8'));
    sql = async (strings, ...vals) => {
        let q = ''; strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
        return (await db.query(q, vals.map(v => (v === undefined ? null : v)))).rows;
    };
}
function call(handler, { method = 'GET', query = {}, body, cookie } = {}) {
    return new Promise(resolve => {
        const headers = { host: HOST, 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' };
        if (cookie) headers.cookie = cookie;
        const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); }, end() { resolve({ status: this.statusCode }); } };
        handler({ method, query, headers, body, socket: {} }, res);
    });
}
async function login(role, email) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}

// A fake Deriv: records every call and answers like the real API does.
function fakeDeriv({ failWith, nextId = 70001 } = {}) {
    const calls = [];
    let id = nextId;
    deriv.setTransport(async messages => {
        const call = messages[messages.length - 1];
        calls.push(call);
        if (failWith) throw new deriv.DerivError(failWith, 'deriv_error');
        if (messages.length === 1) return [{ authorize: { loginid: 'CR1234', scopes: ['read', 'admin'] } }];
        if (call.app_register) return [{ authorize: {} }, { app_register: { app_id: id++ } }];
        if (call.app_update) return [{ authorize: {} }, { app_update: { app_id: call.app_update } }];
        throw new Error('unexpected call');
    });
    return calls;
}

test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    process.env.DERIV_ADMIN_TOKEN = TOKEN;
    process.env.DERIV_REDIRECT_URI = 'https://main.test/callback';
    delete process.env.DERIV_REDIRECT_PATH;
});
test.afterEach(() => { deriv.setTransport(null); delete process.env.DERIV_ADMIN_TOKEN; delete process.env.DERIV_REDIRECT_URI; delete process.env.DERIV_WS_URL; });

test('a new site gets its own Deriv app, with its markup and the main-domain redirect', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: "Julia's Trades!", subdomain: 'julias', markup_percent: '2.5' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.site.app_id, '70001');
    assert.equal(r.body.site.app_status, 'assigned');
    assert.equal(r.body.site.app_auto, true);
    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.equal(sent.app_register, 1);
    assert.equal(sent.app_markup_percentage, 2.5);
    assert.equal(sent.redirect_uri, 'https://main.test/callback');
    assert.equal(sent.homepage, 'https://julias.free.test');
    assert.deepEqual(sent.scopes, ['read', 'trade', 'trading_information']);
    assert.match(sent.name, /^[\w\s-]{1,48}$/, 'name must satisfy Deriv\'s pattern');
    assert.ok(sent.name.includes('Julias Trades'));
    const row = (await sql`SELECT app_id, app_source FROM sites`)[0];
    assert.deepEqual([row.app_id, row.app_source], ['70001', 'api']);
});

test('every site gets a different app, and each app carries only that site\'s markup', async () => {
    const calls = fakeDeriv();
    const a = await login('operator', 'a@example.com');
    const b = await login('operator', 'b@example.com');
    const ra = await call(mySite, { method: 'POST', cookie: a.cookie, body: { name: 'Alpha', subdomain: 'alpha', markup_percent: '1' } });
    const rb = await call(mySite, { method: 'POST', cookie: b.cookie, body: { name: 'Beta', subdomain: 'beta', markup_percent: '3' } });
    assert.notEqual(ra.body.site.app_id, rb.body.site.app_id);
    assert.deepEqual(calls.map(c => c.app_markup_percentage), [1, 3]);
    assert.notEqual(calls[0].name, calls[1].name);
});

test('a custom-domain site returns to its own domain', async () => {
    const calls = fakeDeriv();
    process.env.DERIV_REDIRECT_PATH = 'callback';
    const op = await login('operator', 'op@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Brand', custom_domain: 'trade.brand.com', whatsapp: '254700000000' } });
    assert.equal(calls[0].redirect_uri, 'https://trade.brand.com/callback');
});

test('if Deriv fails the site is still created, falls back to the pool, and says why', async () => {
    fakeDeriv({ failWith: 'Deriv is busy' });
    const adm = await login('admin', 'admin@example.com');
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'pool_add', markup_percent: '2', app_ids: 'POOLAPP1' } });
    const op = await login('operator', 'op@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias', markup_percent: '2' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.site.app_id, 'POOLAPP1');
    assert.equal(r.body.site.app_auto, false);
    const ev = await sql`SELECT detail FROM site_events WHERE event = 'app_create_failed'`;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detail.reason, 'Deriv is busy');
    assert.equal((await sql`SELECT app_source FROM sites`)[0].app_source, null, 'the failed claim is released');
});

test('with no pool app either, the site waits, and the admin can create the app later', async () => {
    fakeDeriv({ failWith: 'Deriv is busy' });
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.site.app_status, 'awaiting');
    const siteId = (await sql`SELECT id FROM sites`)[0].id;

    const still = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'create_app', site_id: siteId } });
    assert.equal(still.status, 409);
    assert.match(still.body.error, /Deriv is busy/);

    fakeDeriv();
    const ok = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'create_app', site_id: siteId } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source, 'api');
    assert.equal((await call(mySite, { cookie: op.cookie })).body.site.app_status, 'assigned');
    const again = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'create_app', site_id: siteId } });
    assert.equal(again.status, 400, 'a site that already has an app is left alone');
});

test('without a token nothing calls Deriv and the pool works exactly as before', async () => {
    delete process.env.DERIV_ADMIN_TOKEN;
    const calls = fakeDeriv();
    const adm = await login('admin', 'admin@example.com');
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'pool_add', markup_percent: '1', app_ids: 'POOLAPP1' } });
    const op = await login('operator', 'op@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    assert.equal(r.body.site.app_id, 'POOLAPP1');
    assert.equal(calls.length, 0);
    const status = await call(admin, { cookie: adm.cookie, query: { resource: 'deriv' } });
    assert.equal(status.body.configured, false);
    assert.deepEqual(status.body.missing, ['DERIV_ADMIN_TOKEN']);
});

test('two requests at the same moment create only one Deriv app', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const created = await sql`INSERT INTO sites (owner_id, domain, name, plan, status, markup_percent) VALUES (${op.id}, 'julias.free.test', 'Julias', 'free', 'active', 1) RETURNING id`;
    const [x, y] = await Promise.all([provisionApp(sql, created[0].id), provisionApp(sql, created[0].id)]);
    assert.equal(calls.length, 1);
    assert.equal([x, y].filter(r => r.app_id).length, 1);
    assert.equal((await sql`SELECT app_id FROM sites`)[0].app_id, '70001');
});

test('changing the markup updates the Deriv app first, and the admin flag stays clear', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias', markup_percent: '1' } });
    const r = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { markup_percent: '2.25' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.site.markup_percent, 2.25);
    const upd = calls[calls.length - 1];
    assert.equal(upd.app_update, 70001);
    assert.equal(upd.app_markup_percentage, 2.25);
    assert.equal(upd.redirect_uri, 'https://main.test/callback');
    const list = await call(admin, { cookie: adm.cookie, query: { resource: 'sites' } });
    assert.equal(list.body.sites[0].markup_pending, false, 'Deriv already has the new markup');
    assert.equal((await sql`SELECT count(*)::int AS n FROM site_events WHERE event = 'markup_confirmed'`)[0].n, 1);
});

test('if Deriv refuses a markup change, nothing changes anywhere', async () => {
    fakeDeriv();
    const op = await login('operator', 'op@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias', markup_percent: '1' } });
    fakeDeriv({ failWith: 'Deriv is busy' });
    const r = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { name: 'Renamed', markup_percent: '3' } });
    assert.equal(r.status, 502);
    assert.ok(r.body.fields.markup_percent);
    const row = (await sql`SELECT name, markup_percent FROM sites`)[0];
    assert.equal(row.name, 'Julias');
    assert.equal(Number(row.markup_percent), 1);
    assert.equal(JSON.stringify(r.body).includes(TOKEN), false);
});

test('edits that do not touch the markup never call Deriv', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    const before = calls.length;
    const r = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { name: 'Renamed', markup_percent: '1' } });
    assert.equal(r.status, 200);
    assert.equal(calls.length, before);
});

test('a hand-assigned or pooled App ID is never changed through the API', async () => {
    const calls = fakeDeriv();
    delete process.env.DERIV_ADMIN_TOKEN;
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias', markup_percent: '1' } });
    const siteId = (await sql`SELECT id FROM sites`)[0].id;
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: '33C8pzDfszs5p4KQabqit' } });
    process.env.DERIV_ADMIN_TOKEN = TOKEN;
    const r = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { markup_percent: '2' } });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 0);
    const list = await call(admin, { cookie: adm.cookie, query: { resource: 'sites' } });
    assert.equal(list.body.sites[0].markup_pending, true, 'the admin is still told to update it by hand');
});

test('admin set_markup also changes the Deriv app, and refuses if Deriv does', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias', markup_percent: '1' } });
    const siteId = (await sql`SELECT id FROM sites`)[0].id;
    const ok = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_markup', site_id: siteId, markup_percent: '2' } });
    assert.equal(ok.status, 200);
    assert.equal(calls[calls.length - 1].app_markup_percentage, 2);
    fakeDeriv({ failWith: 'nope' });
    const bad = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_markup', site_id: siteId, markup_percent: '3' } });
    assert.equal(bad.status, 502);
    assert.equal(Number((await sql`SELECT markup_percent FROM sites`)[0].markup_percent), 2);
});

test('approving a custom domain moves the Deriv app to it', async () => {
    const calls = fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    await call(mySite, { method: 'PUT', cookie: op.cookie, body: { action: 'request_custom_domain', domain: 'trade.julias.com' } });
    const siteId = (await sql`SELECT id FROM sites`)[0].id;
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'approve_custom', site_id: siteId } });
    assert.equal(r.status, 200);
    assert.equal(r.body.warning, undefined);
    const upd = calls[calls.length - 1];
    assert.equal(upd.redirect_uri, 'https://trade.julias.com/');
    assert.equal(upd.homepage, 'https://trade.julias.com');
});

test('if Deriv is down when a custom domain is approved, the switch still happens and the admin is warned', async () => {
    fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    await call(mySite, { method: 'PUT', cookie: op.cookie, body: { action: 'request_custom_domain', domain: 'trade.julias.com' } });
    const siteId = (await sql`SELECT id FROM sites`)[0].id;
    fakeDeriv({ failWith: 'down' });
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'approve_custom', site_id: siteId } });
    assert.equal(r.status, 200);
    assert.match(r.body.warning, /redirect was not updated/);
    assert.equal((await sql`SELECT domain FROM sites`)[0].domain, 'trade.julias.com');
});

test('only an admin can test the connection, and it reports a token without the Admin scope', async () => {
    fakeDeriv();
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    assert.equal((await call(admin, { method: 'POST', cookie: op.cookie, body: { action: 'deriv_test' } })).status, 403);
    const ok = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'deriv_test' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.loginid, 'CR1234');
    deriv.setTransport(async () => [{ authorize: { loginid: 'CR1234', scopes: ['read'] } }]);
    const weak = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'deriv_test' } });
    assert.equal(weak.status, 409);
    assert.match(weak.body.error, /Admin scope/);
});

test('app names always satisfy Deriv\'s pattern', () => {
    const ok = n => { const name = deriv.appName({ id: 12, name: n }); assert.match(name, /^[\w\s-]{1,48}$/, n); return name; };
    ok('Julia\'s <b>Trades</b> & Co.');
    ok('日本語のサイト');
    ok('x'.repeat(200));
    ok('');
    assert.ok(ok('x'.repeat(200)).endsWith('EPM-12'), 'the unique suffix survives truncation');
});

// ---- the real socket code, against a local server that speaks Deriv's protocol ----
function startServer(handler) {
    return new Promise(resolve => {
        const wss = new WebSocketServer({ port: 0 }, () => resolve({ wss, url: `ws://127.0.0.1:${wss.address().port}` }));
        wss.on('connection', (ws, req) => {
            const seen = { url: req.url, messages: [] };
            ws.on('message', raw => { const m = JSON.parse(String(raw)); seen.messages.push(m); handler(ws, m, seen); });
        });
    });
}

test('real socket: authorizes first, then registers, and reads the App ID', async () => {
    const seen = [];
    const { wss, url } = await startServer((ws, m, s) => {
        seen.push(m);
        if (m.authorize) ws.send(JSON.stringify({ msg_type: 'authorize', authorize: { loginid: 'CR1', scopes: ['admin'] } }));
        else if (m.app_register) ws.send(JSON.stringify({ msg_type: 'app_register', app_register: { app_id: 123456 } }));
    });
    try {
        process.env.DERIV_WS_URL = url;
        const id = await deriv.registerApp({ id: 5, name: 'Julias', domain: 'julias.free.test', plan: 'free', markup_percent: '1.50' });
        assert.equal(id, '123456');
        assert.equal(seen[0].authorize, TOKEN, 'authorize is always the first message');
        assert.equal(seen[1].app_register, 1);
        assert.equal(seen[1].app_markup_percentage, 1.5);
    } finally { wss.close(); }
});

test('real socket: a Deriv error becomes a clear message that never contains the token', async () => {
    const { wss, url } = await startServer((ws, m) => {
        if (m.authorize) ws.send(JSON.stringify({ error: { code: 'InvalidToken', message: 'The token is invalid.' } }));
    });
    try {
        process.env.DERIV_WS_URL = url;
        await assert.rejects(() => deriv.registerApp({ id: 5, name: 'Julias', domain: 'julias.free.test', plan: 'free', markup_percent: 1 }),
            e => { assert.match(e.message, /token is invalid/); assert.equal(e.message.includes(TOKEN), false); return true; });
    } finally { wss.close(); }
});

test('real socket: Deriv refusing the app (not the login) is reported', async () => {
    const { wss, url } = await startServer((ws, m) => {
        if (m.authorize) ws.send(JSON.stringify({ authorize: { scopes: ['admin'] } }));
        else ws.send(JSON.stringify({ error: { code: 'PermissionDenied', message: 'Permission denied, requires admin scope.' } }));
    });
    try {
        process.env.DERIV_WS_URL = url;
        await assert.rejects(() => deriv.registerApp({ id: 5, name: 'J', domain: 'j.free.test', plan: 'free', markup_percent: 1 }), /requires admin scope/);
    } finally { wss.close(); }
});

test('real socket: an unreachable Deriv fails fast with a plain message', async () => {
    process.env.DERIV_WS_URL = 'ws://127.0.0.1:1';
    await assert.rejects(() => deriv.registerApp({ id: 5, name: 'J', domain: 'j.free.test', plan: 'free', markup_percent: 1 }), /Could not reach Deriv|closed/);
});

test('real socket: a silent Deriv times out instead of hanging the sign-up', async () => {
    const { wss, url } = await startServer(() => { /* never answers */ });
    try {
        process.env.DERIV_WS_URL = url;
        const started = Date.now();
        await assert.rejects(() => deriv.defaultTransport([{ authorize: TOKEN }], { timeoutMs: 300 }), /did not answer in time/);
        assert.ok(Date.now() - started < 3000);
    } finally { wss.close(); }
});

test('the connection id is not a secret and the token is only ever sent as the authorize message', async () => {
    const { wss, url } = await startServer((ws, m, s) => {
        if (m.authorize) ws.send(JSON.stringify({ authorize: { loginid: 'CR1', scopes: ['admin'] } }));
        assert.equal(s.url.includes(TOKEN), false, 'the token is never put in the address');
    });
    try {
        process.env.DERIV_WS_URL = url;
        const c = await deriv.checkConnection();
        assert.equal(c.ok, true);
    } finally { wss.close(); }
});
