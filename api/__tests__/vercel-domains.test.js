// Adding approved custom domains to the Vercel project. Real handlers + real SQL (in-memory Postgres); Vercel is replaced by a fake.
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
const VD = require('../_lib/vercel-domains');

const HOST = 'builder.test';
const TOKEN = 'SECRET-VERCEL-TOKEN-123';

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

// A fake Vercel: records every request and answers with whatever you tell it to.
function fakeVercel(reply = { status: 200, body: { name: 'x', verified: true } }) {
    const calls = [];
    VD.setTransport(async (url, options) => {
        calls.push({ url, options });
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(url, options) : reply;
    });
    return calls;
}

function configure({ team } = {}) {
    process.env.DOMAINS_VERCEL_TOKEN = TOKEN;
    process.env.DOMAINS_VERCEL_PROJECT = 'trading-site';
    if (team) process.env.DOMAINS_VERCEL_TEAM = team; else delete process.env.DOMAINS_VERCEL_TEAM;
}

// A free site whose operator has asked for trade.julias.com.
async function siteWithRequest() {
    const op = await login('operator', 'op@example.com');
    const adm = await login('admin', 'admin@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Julias', subdomain: 'julias' } });
    await call(mySite, { method: 'PUT', cookie: op.cookie, body: { action: 'request_custom_domain', domain: 'trade.julias.com' } });
    const siteId = (await sql`SELECT id FROM sites`)[0].id;
    return { op, adm, siteId };
}
const approve = (adm, siteId) => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'approve_custom', site_id: siteId } });
const events = async siteId => (await sql`SELECT event FROM site_events WHERE site_id = ${siteId} ORDER BY id`).map(r => r.event);

test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    delete process.env.DOMAINS_VERCEL_TOKEN; delete process.env.DOMAINS_VERCEL_PROJECT; delete process.env.DOMAINS_VERCEL_TEAM; delete process.env.DOMAINS_VERCEL_API;
});
test.afterEach(() => {
    VD.setTransport(null);
    delete process.env.DOMAINS_VERCEL_TOKEN; delete process.env.DOMAINS_VERCEL_PROJECT; delete process.env.DOMAINS_VERCEL_TEAM; delete process.env.DOMAINS_VERCEL_API;
});

// ---------- the module on its own ----------

test('with no settings it does nothing and makes no network call', async () => {
    const calls = fakeVercel();
    const r = await VD.addDomain('trade.julias.com');
    assert.equal(r.status, 'off');
    assert.equal(calls.length, 0);
    assert.deepEqual(VD.missingSettings(), ['DOMAINS_VERCEL_TOKEN', 'DOMAINS_VERCEL_PROJECT']);
});

test('it asks Vercel to add the domain to the right project, with the token in the header only', async () => {
    configure();
    const calls = fakeVercel();
    const r = await VD.addDomain('Trade.Julias.com');
    assert.equal(r.status, 'added');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.vercel.com/v10/projects/trading-site/domains');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'trade.julias.com' });
    assert.ok(!JSON.stringify(r).includes(TOKEN), 'the token must never come back out');
});

test('a team project adds the team id to the address', async () => {
    configure({ team: 'team_abc123' });
    const calls = fakeVercel();
    await VD.addDomain('trade.julias.com');
    assert.equal(calls[0].url, 'https://api.vercel.com/v10/projects/trading-site/domains?teamId=team_abc123');
});

test('Vercel saying "not verified yet" is reported, not hidden', async () => {
    configure();
    fakeVercel({ status: 200, body: { name: 'x', verified: false, verification: [{ type: 'TXT', domain: '_vercel.julias.com', value: 'vc-domain-verify=abc' }] } });
    const r = await VD.addDomain('trade.julias.com');
    assert.equal(r.status, 'needs_verification');
    assert.match(r.message, /verify/);
});

test('each kind of Vercel failure gets its own plain message', async () => {
    configure();
    fakeVercel({ status: 409, body: { error: { code: 'domain_taken', message: 'Cannot create project domain since owner already has x' } } });
    assert.equal((await VD.addDomain('trade.julias.com')).status, 'conflict');
    fakeVercel({ status: 400, body: { error: { code: 'x', message: 'Domain already exists on this project' } } });
    assert.equal((await VD.addDomain('trade.julias.com')).status, 'already_added');
    fakeVercel({ status: 400, body: { error: { code: 'bad', message: 'Something else is wrong' } } });
    assert.equal((await VD.addDomain('trade.julias.com')).status, 'failed');
    fakeVercel({ status: 401, body: { error: { message: 'invalid token' } } });
    assert.match((await VD.addDomain('trade.julias.com')).message, /refused the token/);
    fakeVercel({ status: 403, body: {} });
    assert.match((await VD.addDomain('trade.julias.com')).message, /refused the token/);
    fakeVercel({ status: 404, body: {} });
    assert.match((await VD.addDomain('trade.julias.com')).message, /could not find the project/);
    fakeVercel({ status: 500, body: null });
    assert.equal((await VD.addDomain('trade.julias.com')).status, 'failed');
});

test('a network failure or timeout is reported and never thrown', async () => {
    configure();
    fakeVercel(new Error('socket hang up'));
    const r = await VD.addDomain('trade.julias.com');
    assert.equal(r.status, 'failed');
    assert.match(r.message, /Could not reach Vercel/);
});

test('a badly formed domain is refused before anything is sent', async () => {
    configure();
    const calls = fakeVercel();
    for (const bad of ['', 'nodot', 'bad domain.com', 'a/b.com', '../x.com', 'x.com/../../y']) {
        assert.equal((await VD.addDomain(bad)).status, 'failed', bad);
    }
    assert.equal(calls.length, 0);
});

// ---------- approval flow ----------

test('approving a custom domain adds it to Vercel and tells the admin', async () => {
    configure();
    const calls = fakeVercel();
    const { adm, siteId } = await siteWithRequest();
    const r = await approve(adm, siteId);
    assert.equal(r.status, 200);
    assert.equal(r.body.warning, undefined);
    assert.match(r.body.notice, /was added to the Vercel project/);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).name, 'trade.julias.com');
    assert.equal((await sql`SELECT domain, plan FROM sites`)[0].domain, 'trade.julias.com');
    assert.ok((await events(siteId)).includes('domain_vercel_added'));
});

test('if Vercel is down, the site is still switched and the admin is warned', async () => {
    configure();
    fakeVercel({ status: 500, body: {} });
    const { adm, siteId } = await siteWithRequest();
    const r = await approve(adm, siteId);
    assert.equal(r.status, 200);
    assert.match(r.body.warning, /The site is switched, but Vercel answered with an error/);
    const row = (await sql`SELECT domain, plan, status FROM sites`)[0];
    assert.equal(row.domain, 'trade.julias.com');
    assert.equal(row.plan, 'custom');
    assert.ok((await events(siteId)).includes('domain_vercel_failed'));
});

test('with the Vercel connection off, approval works exactly as before: no warning, no call', async () => {
    const calls = fakeVercel();
    const { adm, siteId } = await siteWithRequest();
    const r = await approve(adm, siteId);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(calls.length, 0);
    assert.equal((await sql`SELECT domain FROM sites`)[0].domain, 'trade.julias.com');
});

// ---------- the "Connect to Vercel" retry ----------

test('connect_domain: admins only, own-domain sites only, and only when set up', async () => {
    const calls = fakeVercel();
    const { op, adm, siteId } = await siteWithRequest();
    const body = { action: 'connect_domain', site_id: siteId };

    assert.equal((await call(admin, { method: 'POST', cookie: op.cookie, body })).status, 403);

    // still a free site
    configure();
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body })).status, 400);

    await approve(adm, siteId);
    calls.length = 0;

    // not set up
    delete process.env.DOMAINS_VERCEL_TOKEN;
    const off = await call(admin, { method: 'POST', cookie: adm.cookie, body });
    assert.equal(off.status, 409);
    assert.match(off.body.error, /DOMAINS_VERCEL_TOKEN/);
    assert.equal(calls.length, 0);
});

test('connect_domain retries the add, records it, and reports the result', async () => {
    configure();
    fakeVercel({ status: 500, body: {} });
    const { adm, siteId } = await siteWithRequest();
    await approve(adm, siteId);                       // Vercel failed during approval

    const calls = fakeVercel();                       // Vercel is back
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'connect_domain', site_id: siteId } });
    assert.equal(r.status, 200);
    assert.match(r.body.notice, /was added/);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).name, 'trade.julias.com');
    const audit = await sql`SELECT action FROM audit_log WHERE action = 'connect_domain'`;
    assert.equal(audit.length, 1);

    fakeVercel({ status: 409, body: { error: { message: 'taken' } } });
    const again = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'connect_domain', site_id: siteId } });
    assert.match(again.body.warning, /another project or account/);
});
