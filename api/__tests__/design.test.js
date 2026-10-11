// Website design requests: an operator asks, the admin answers, nobody sees anyone else's.
// Real handlers + real SQL (in-memory Postgres). Safaricom and Vercel are replaced by fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const library = require('../library');
const admin = require('../admin');
const mySite = require('../my-site');
const A = require('../_lib/auth');

const HOST = 'builder.test', SECRET = 'cb-secret', TOKEN = 'VERCEL-TOKEN-SECRET-1';

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


const lib = (op, body) => call(library, { method: 'POST', cookie: op.cookie, body });
const adm = (ad, body) => call(admin, { method: 'POST', cookie: ad.cookie, body });
const GOOD = { action: 'request_design', business_name: 'Julia Trades', kind: 'Trading website', details: 'A dark, premium site with a bot library and a signup page.', colors: 'navy and gold', links: 'https://example.com', contact: '0712345678' };

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, PLATFORM_ROOT_DOMAIN: 'free.test' });
});

test('an operator sends a design request and sees it with its status', async () => {
    const op = await login('operator', 'o@example.com');
    const r = await lib(op, GOOD);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.designs.length, 1);
    assert.equal(r.body.designs[0].status, 'open');
    assert.equal(r.body.designs[0].business_name, 'Julia Trades');
    assert.ok(r.body.design_kinds.includes('Landing page'));
    const again = (await call(library, { cookie: op.cookie })).body;
    assert.equal(again.designs.length, 1);
});

test('missing or silly input is refused with the field named', async () => {
    const op = await login('operator', 'o@example.com');
    for (const [patch, field] of [[{ business_name: '' }, 'business_name'], [{ kind: 'Nonsense' }, 'kind'], [{ details: 'too short' }, 'details']]) {
        const r = await lib(op, { ...GOOD, ...patch });
        assert.equal(r.status, 400);
        assert.ok(r.body.fields[field], field);
    }
    assert.equal((await sql`SELECT count(*)::int AS n FROM design_requests`)[0].n, 0);
});

test('the contact defaults to the account email, and text is stored as text', async () => {
    const op = await login('operator', 'o@example.com');
    await lib(op, { ...GOOD, contact: '', business_name: '<b>Bold</b> & Co' });
    const row = (await sql`SELECT * FROM design_requests`)[0];
    assert.equal(row.contact, 'o@example.com');
    assert.equal(row.business_name, '<b>Bold</b> & Co');     // the dashboard shows it with textContent, so it is never run as HTML
});

test('at most 3 requests in progress at once; a cancelled one frees a place', async () => {
    const op = await login('operator', 'o@example.com');
    for (let i = 0; i < 3; i++) assert.equal((await lib(op, GOOD)).status, 201);
    const fourth = await lib(op, GOOD);
    assert.equal(fourth.status, 400);
    assert.match(fourth.body.error, /3 design requests/);
    const id = (await sql`SELECT id FROM design_requests ORDER BY id LIMIT 1`)[0].id;
    assert.equal((await lib(op, { action: 'cancel_design', id })).status, 200);
    assert.equal((await lib(op, GOOD)).status, 201);
});

test('an operator can only cancel their own open request', async () => {
    const a = await login('operator', 'a@example.com'), b = await login('operator', 'b@example.com');
    await lib(a, GOOD);
    const id = (await sql`SELECT id FROM design_requests`)[0].id;
    assert.equal((await lib(b, { action: 'cancel_design', id })).status, 404);
    assert.equal((await sql`SELECT status FROM design_requests`)[0].status, 'open');
    assert.equal((await call(library, { cookie: b.cookie })).body.designs.length, 0);      // and never sees it
});

test('the admin sees every request, moves it along, and the operator sees the note', async () => {
    const op = await login('operator', 'o@example.com'), ad = await login('admin', 'a@example.com');
    await lib(op, GOOD);
    const id = (await sql`SELECT id FROM design_requests`)[0].id;
    const view = (await call(admin, { cookie: ad.cookie, query: { resource: 'library' } })).body;
    assert.equal(view.designs.length, 1);
    assert.equal(view.designs[0].owner_email, 'o@example.com');
    assert.equal((await adm(ad, { action: 'design_answer', id, status: 'in_progress', note: 'Starting on it' })).status, 200);
    assert.equal((await call(library, { cookie: op.cookie })).body.designs[0].status, 'in_progress');
    assert.equal((await adm(ad, { action: 'design_answer', id, status: 'declined', note: '' })).status, 400);       // a decline needs a reason
    assert.equal((await adm(ad, { action: 'design_answer', id, status: 'done', note: 'Sent to your email' })).status, 200);
    const d = (await call(library, { cookie: op.cookie })).body.designs[0];
    assert.equal(d.status, 'done');
    assert.equal(d.admin_note, 'Sent to your email');
    assert.equal((await adm(ad, { action: 'design_answer', id, status: 'in_progress' })).status, 404);               // finished ones stay finished
});

test('operators cannot use the admin action, and signed-out visitors cannot request', async () => {
    const op = await login('operator', 'o@example.com');
    await lib(op, GOOD);
    const id = (await sql`SELECT id FROM design_requests`)[0].id;
    assert.notEqual((await adm(op, { action: 'design_answer', id, status: 'done' })).status, 200);
    assert.equal((await sql`SELECT status FROM design_requests`)[0].status, 'open');
    assert.equal((await call(library, { method: 'POST', body: GOOD })).status, 401);
});
