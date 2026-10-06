// Per-site markup and App ID. Real handlers + real SQL (in-memory Postgres).
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
const A = require('../_lib/auth');

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
            json(b) { resolve({ status: this.statusCode, body: b }); }, end() { resolve({ status: this.statusCode }); } };
        handler({ method, query, headers, body, socket: {} }, res);
    });
}
async function login(role, email) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}

test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
});

test('a new site defaults to 1% markup and awaits an App ID', async () => {
    const op = await login('operator', 'op@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias Trades', subdomain: 'julias' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.site.markup_percent, 1);
    assert.equal(r.body.site.app_id, '');
    assert.equal(r.body.site.app_status, 'awaiting');
});

test('the operator can choose a markup when creating the site', async () => {
    const op = await login('operator', 'op@example.com');
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias Trades', subdomain: 'julias', markup_percent: '1.94' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.site.markup_percent, 1.94);
});

test('a markup above 3% or malformed is refused and nothing is created', async () => {
    const op = await login('operator', 'op@example.com');
    for (const bad of ['3.5', '-1', 'abc', '1.999']) {
        const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias Trades', subdomain: 'julias', markup_percent: bad } });
        assert.equal(r.status, 400, bad);
        assert.ok(r.body.fields.markup_percent, bad);
    }
    assert.equal((await sql`SELECT count(*)::int AS n FROM sites`)[0].n, 0);
});

test('an operator cannot change markup or App ID by editing the site', async () => {
    const op = await login('operator', 'op@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias Trades', subdomain: 'julias', markup_percent: '2' } });
    const r = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { name: 'Renamed', markup_percent: '0.1', app_id: 'HACKED123' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.site.name, 'Renamed');
    assert.equal(r.body.site.markup_percent, 2);
    assert.equal(r.body.site.app_id, '');
});

test('only an admin can assign an App ID or set the markup', async () => {
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias Trades', subdomain: 'julias' } });
    const siteId = (await sql`SELECT id FROM sites LIMIT 1`)[0].id;

    const denied = await call(admin, { method: 'POST', cookie: op.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: 'ABC12345' } });
    assert.equal(denied.status, 403);

    const bad = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: 'not valid!' } });
    assert.equal(bad.status, 400);

    const ok = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: '33C8pzDfszs5p4KQabqit' } });
    assert.equal(ok.status, 200);
    const mk = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_markup', site_id: siteId, markup_percent: '2.5' } });
    assert.equal(mk.status, 200);
    const tooHigh = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_markup', site_id: siteId, markup_percent: '9' } });
    assert.equal(tooHigh.status, 400);

    const mine = await call(mySite, { cookie: op.cookie });
    assert.equal(mine.body.site.app_id, '33C8pzDfszs5p4KQabqit');
    assert.equal(mine.body.site.app_status, 'assigned');
    assert.equal(mine.body.site.markup_percent, 2.5);

    const list = await call(admin, { cookie: adm.cookie, query: { resource: 'sites' } });
    assert.equal(list.body.sites[0].app_id, '33C8pzDfszs5p4KQabqit');

    const cleared = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: '' } });
    assert.equal(cleared.status, 200);
    assert.equal((await call(mySite, { cookie: op.cookie })).body.site.app_status, 'awaiting');
});

test('the schema can be run twice without error', async () => {
    const db = new PGlite();
    const text = fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8');
    await db.exec(text); await db.exec(text);
});
