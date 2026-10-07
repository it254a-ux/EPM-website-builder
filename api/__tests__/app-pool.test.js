// Pre-made Deriv apps handed out automatically. Real handlers + real SQL (in-memory Postgres).
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
let seq = 0;
async function login(role) {
    seq += 1;
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${`u${seq}@example.com`}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}
const create = (op, sub, markup) => call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Site ' + sub, subdomain: sub, markup_percent: markup } });
const poolAdd = (adm, markup, ids) => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'pool_add', markup_percent: markup, app_ids: ids } });

let adm;
test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    adm = await login('admin');
});

test('a new site is given an unused app with its exact markup, automatically', async () => {
    assert.equal((await poolAdd(adm, '2', 'APPtwoA111\nAPPtwoB222')).body.added, 2);
    const op = await login('operator');
    const r = await create(op, 'julias', '2');
    assert.equal(r.status, 201);
    assert.equal(r.body.site.app_id, 'APPtwoA111');
    assert.equal(r.body.site.app_status, 'assigned');
    assert.equal(r.body.site.markup_locked, true);
    const mine = await call(mySite, { cookie: op.cookie });
    assert.equal(mine.body.site.app_id, 'APPtwoA111');
});

test('each app goes to one site only, and a tier that runs out leaves the site waiting', async () => {
    await poolAdd(adm, '2', 'APPtwoA111');
    const a = await login('operator'), b = await login('operator');
    assert.equal((await create(a, 'alpha', '2')).body.site.app_id, 'APPtwoA111');
    const second = await create(b, 'bravo', '2');
    assert.equal(second.body.site.app_id, '');
    assert.equal(second.body.site.app_status, 'awaiting');
    assert.equal(second.body.site.markup_locked, false);
});

test('a site never gets an app from a different markup tier', async () => {
    await poolAdd(adm, '3', 'APPthree111');
    const op = await login('operator');
    assert.equal((await create(op, 'julias', '1.5')).body.site.app_id, '');
});

test('adding apps later hands them to waiting sites, oldest first', async () => {
    const a = await login('operator'), b = await login('operator'), c = await login('operator');
    await create(a, 'alpha', '1.5'); await create(b, 'bravo', '1.5'); await create(c, 'charlie', '2');
    const r = await poolAdd(adm, '1.5', 'APPone5A111');
    assert.equal(r.body.assigned, 1);
    assert.equal((await call(mySite, { cookie: a.cookie })).body.site.app_id, 'APPone5A111');
    assert.equal((await call(mySite, { cookie: b.cookie })).body.site.app_id, '');
    assert.equal((await call(mySite, { cookie: c.cookie })).body.site.app_id, '');
});

test('while waiting, picking a markup that has a stocked app assigns it; once assigned the markup is locked', async () => {
    await poolAdd(adm, '2.5', 'APPtwo5A111');
    const op = await login('operator');
    await create(op, 'julias', '1');
    const changed = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { markup_percent: '2.5' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.site.app_id, 'APPtwo5A111');
    assert.equal(changed.body.site.markup_locked, true);
    const locked = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { markup_percent: '3' } });
    assert.equal(locked.status, 400);
    assert.match(locked.body.fields.markup_percent, /fixed by your Deriv app/);
    const same = await call(mySite, { method: 'PUT', cookie: op.cookie, body: { name: 'Renamed', markup_percent: '2.5' } });
    assert.equal(same.status, 200);
    assert.equal(same.body.site.markup_percent, 2.5);
});

test('pool_add validates input, skips repeats and apps a site already uses', async () => {
    assert.equal((await poolAdd(adm, '2', '')).status, 400);
    assert.equal((await poolAdd(adm, '2', 'ok123456 bad id!')).status, 400);
    assert.equal((await poolAdd(adm, '0.5', 'APPtwoA111')).status, 400);
    assert.equal((await poolAdd(adm, '2', 'x'.repeat(41))).status, 400);
    const first = await poolAdd(adm, '2', 'APPtwoA111, APPtwoA111, APPtwoB222');
    assert.deepEqual([first.body.added, first.body.skipped], [2, 0], 'repeats inside one paste are merged, not counted as skipped');
    const again = await poolAdd(adm, '2', 'APPtwoA111');
    assert.deepEqual([again.body.added, again.body.skipped], [0, 1]);

    const op = await login('operator');
    await create(op, 'manual', '1');
    const siteId = (await sql`SELECT id FROM sites LIMIT 1`)[0].id;
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: 'HANDpicked1' } });
    const dup = await poolAdd(adm, '1', 'HANDpicked1');
    assert.deepEqual([dup.body.added, dup.body.skipped], [0, 1]);
});

test('only admins can use the pool, and only unused apps can be removed', async () => {
    const op = await login('operator');
    assert.equal((await call(admin, { method: 'POST', cookie: op.cookie, body: { action: 'pool_add', markup_percent: '2', app_ids: 'APPtwoA111' } })).status, 403);
    assert.equal((await call(admin, { cookie: op.cookie, query: { resource: 'pool' } })).status, 403);

    await poolAdd(adm, '2', 'APPtwoA111 APPtwoB222');
    await create(op, 'julias', '2'); // takes APPtwoA111
    const list = await call(admin, { cookie: adm.cookie, query: { resource: 'pool' } });
    assert.deepEqual(list.body.tiers, [{ markup_percent: 2, free: 1, used: 1 }]);
    const used = list.body.apps.find(a => a.app_id === 'APPtwoA111'), free = list.body.apps.find(a => a.app_id === 'APPtwoB222');
    assert.equal(used.site_domain, 'julias.free.test');
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'pool_remove', pool_id: used.id } })).status, 400);
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'pool_remove', pool_id: free.id } })).status, 200);
});

test('a deleted site retires its app: it is never handed to anyone else', async () => {
    await poolAdd(adm, '2', 'APPtwoA111');
    const op = await login('operator');
    await create(op, 'julias', '2');
    const siteId = (await sql`SELECT id FROM sites LIMIT 1`)[0].id;
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'delete_site', site_id: siteId } });
    const next = await login('operator');
    assert.equal((await create(next, 'newbie', '2')).body.site.app_id, '');
    const tiers = (await call(admin, { cookie: adm.cookie, query: { resource: 'pool' } })).body.tiers;
    assert.deepEqual(tiers, [{ markup_percent: 2, free: 0, used: 1 }]);
});

test('an admin can override a pooled app by hand; the markup is then editable again', async () => {
    await poolAdd(adm, '2', 'APPtwoA111');
    const op = await login('operator');
    await create(op, 'julias', '2');
    const siteId = (await sql`SELECT id FROM sites LIMIT 1`)[0].id;
    const blocked = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_markup', site_id: siteId, markup_percent: '3' } });
    assert.equal(blocked.status, 400);
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'set_app_id', site_id: siteId, app_id: 'HANDpicked1' } });
    assert.equal(r.status, 200);
    const mine = await call(mySite, { cookie: op.cookie });
    assert.equal(mine.body.site.app_id, 'HANDpicked1');
    assert.equal(mine.body.site.markup_locked, false);
    assert.equal((await call(mySite, { method: 'PUT', cookie: op.cookie, body: { markup_percent: '3' } })).status, 200);
});

test('assign_from_pool serves a waiting site on demand and refuses when none is free', async () => {
    const op = await login('operator');
    await create(op, 'julias', '2');
    const siteId = (await sql`SELECT id FROM sites LIMIT 1`)[0].id;
    const none = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'assign_from_pool', site_id: siteId } });
    assert.equal(none.status, 409);
    await sql`INSERT INTO app_pool (app_id, markup_percent) VALUES ('APPtwoA111', 2)`;
    const ok = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'assign_from_pool', site_id: siteId } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.app_id, 'APPtwoA111');
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'assign_from_pool', site_id: siteId } })).status, 400);
});

test('two sites created at the same moment never share an app', async () => {
    await poolAdd(adm, '2', 'APPtwoA111 APPtwoB222');
    const ops = await Promise.all([login('operator'), login('operator')]);
    const [x, y] = await Promise.all([create(ops[0], 'one', '2'), create(ops[1], 'two', '2')]);
    const ids = [x.body.site.app_id, y.body.site.app_id].sort();
    assert.deepEqual(ids, ['APPtwoA111', 'APPtwoB222']);
});
