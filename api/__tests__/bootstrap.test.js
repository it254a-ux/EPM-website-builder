// The fast-loading endpoints: one request for the whole operator dashboard, one for the whole admin page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const mySite = require('../my-site');
const admin = require('../admin');
const bootstrap = require('../bootstrap');
const commissionsApi = require('../commissions');
const libraryApi = require('../library');
const A = require('../_lib/auth');
const L = require('../_lib/library');

const HOST = 'builder.test';
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
            json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); }, end() { resolve({ status: this.statusCode }); } };
        handler({ method, query, headers, body, socket: {} }, res);
    });
}
async function login(role, email) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}
async function operator(email, sub) {
    const op = await login('operator', email);
    assert.equal((await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: sub, subdomain: sub } })).status, 201);
    return op;
}
const strip = o => { const c = { ...o }; delete c.__status; return JSON.parse(JSON.stringify(c)); };

test.beforeEach(async () => { await freshDb(); process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test'; L.setBlob(null); });

test('one request returns exactly what the separate calls return', async () => {
    const op = await operator('a@x.test', 'alpha');
    await call(libraryApi, { method: 'POST', cookie: op.cookie, body: { action: 'request_bot', title: 'Idea', details: 'Please build me a bot' } });
    const b = await call(bootstrap, { cookie: op.cookie });
    assert.equal(b.status, 200);
    assert.equal(b.headers['Cache-Control'], 'no-store');
    assert.equal(b.body.owner.email, 'a@x.test');
    assert.equal(b.body.google, false);
    const site = (await call(mySite, { cookie: op.cookie })).body;
    assert.deepEqual(strip(b.body.state), strip(site));
    assert.deepEqual(strip(b.body.commissions), strip((await call(commissionsApi, { cookie: op.cookie })).body));
    assert.deepEqual(strip(b.body.library), strip((await call(libraryApi, { cookie: op.cookie })).body));
    assert.equal(b.body.library.requests.length, 1);
});

test('an operator with no site still gets a full answer, and nobody else\'s data', async () => {
    const op = await login('operator', 'n@x.test');
    const other = await operator('o@x.test', 'omega');
    await call(libraryApi, { method: 'POST', cookie: other.cookie, body: { action: 'add_bot', name: 'secret bot', description: 'd', market: 'm', risk_level: 'Low', xml_content: '<xml></xml>' } });
    const b = await call(bootstrap, { cookie: op.cookie });
    assert.equal(b.status, 200);
    assert.equal(b.body.state.site, null);
    assert.equal(b.body.library.site, null);
    assert.ok(!JSON.stringify(b.body).includes('secret bot'));
    assert.ok(!JSON.stringify(b.body).includes('o@x.test'));
});

test('signed-out and admin accounts get only who they are, with no dashboard data', async () => {
    const out = await call(bootstrap, {});
    assert.equal(out.status, 200); assert.deepEqual(out.body, { owner: null, google: false });
    const a = await login('admin', 'adm@x.test');
    const r = await call(bootstrap, { cookie: a.cookie });
    assert.equal(r.status, 200); assert.equal(r.body.owner.role, 'admin');
    assert.equal(r.body.commissions, undefined); assert.equal(r.body.library, undefined); assert.equal(r.body.state, undefined);
    assert.equal((await call(bootstrap, { method: 'POST' })).status, 405);
});

test('bootstrap only answers on the platform host', async () => {
    process.env.PLATFORM_HOSTS = 'other.test';
    assert.equal((await call(bootstrap, {})).status, 404);
});

test('the admin page loads every list in one request, the same as the separate requests', async () => {
    const a = await login('admin', 'adm@x.test');
    const op = await operator('a@x.test', 'alpha');
    await call(libraryApi, { method: 'POST', cookie: op.cookie, body: { action: 'request_bot', title: 'Idea', details: 'Please build me a bot' } });
    const all = await call(admin, { query: { resource: 'all' }, cookie: a.cookie });
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.body).sort(), ['commissions', 'deriv', 'library', 'owners', 'pool', 'sites']);
    for (const k of Object.keys(all.body)) {
        const one = await call(admin, { query: { resource: k }, cookie: a.cookie });
        assert.deepEqual(JSON.parse(JSON.stringify(all.body[k])), JSON.parse(JSON.stringify(one.body)), k);
    }
    assert.equal(all.body.sites.sites.length, 1);
    assert.equal(all.body.library.requests.length, 1);
});

test('the admin lists still refuse operators and unknown names', async () => {
    const a = await login('admin', 'adm@x.test');
    const op = await login('operator', 'o@x.test');
    assert.equal((await call(admin, { query: { resource: 'all' }, cookie: op.cookie })).status, 403);
    assert.equal((await call(admin, { query: { resource: 'all' } })).status, 401);
    assert.equal((await call(admin, { query: { resource: 'nope' }, cookie: a.cookie })).status, 400);
    assert.equal((await call(admin, { query: { resource: 'constructor' }, cookie: a.cookie })).status, 400);
    assert.equal((await call(admin, { query: { resource: 'audit' }, cookie: a.cookie })).status, 200);
});
