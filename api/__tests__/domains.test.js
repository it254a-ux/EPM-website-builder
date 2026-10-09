// Domain search for operators. Real handler + real SQL (in-memory Postgres); Vercel's registrar is replaced by a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const domains = require('../domains');
const A = require('../_lib/auth');
const R = require('../_lib/vercel-registrar');

const HOST = 'builder.test';

async function freshDb() {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8'));
    sql = async (strings, ...vals) => {
        let q = ''; strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
        return (await db.query(q, vals.map(v => (v === undefined ? null : v)))).rows;
    };
}
function call(handler, { method = 'GET', query = {}, cookie } = {}) {
    return new Promise(resolve => {
        const headers = { host: HOST, 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' };
        if (cookie) headers.cookie = cookie;
        const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); }, end() { resolve({ status: this.statusCode }); } };
        handler({ method, query, headers, socket: {} }, res);
    });
}
async function login(role, email) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}

// What Vercel answers for mybrand.<ending>.
const VERCEL = {
    'mybrand.com':     { available: true,  years: 1, price: '11.25', renewalPrice: '11.25', premium: false },
    'mybrand.net':     { available: false },
    'mybrand.org':     { available: true,  years: 1, price: 9.99,    renewalPrice: 10.99,   premium: false },
    'mybrand.xyz':     { available: true,  years: 2, price: 3.98,    renewalPrice: 13,      premium: false },
    'mybrand.site':    { available: true,  years: 1, price: 1.99,    renewalPrice: 27,      premium: false },
    'mybrand.online':  { available: true,  years: 1, price: 4000,    renewalPrice: 4000,    premium: true },
    'mybrand.tech':    { available: true,  years: 1, price: 7.99,    renewalPrice: 49,      premium: false },
    'mybrand.store':   { available: true,  years: 1 /* no price at all */, premium: false },
    'mybrand.trading': { available: true,  years: 1, price: 24.99,   renewalPrice: 24.99,   premium: false },
};
function fakeRegistrar(reply) {
    const calls = [];
    R.setTransport(async (url, options) => {
        calls.push({ url, options });
        if (reply instanceof Error) throw reply;
        if (reply) return reply;
        const names = JSON.parse(options.body).domains;
        return { status: 200, body: { results: names.map(d => ({ domain: d, ...(VERCEL[d] || { available: false }) })) } };
    });
    return calls;
}

test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    process.env.KES_PER_USD = '130';
    process.env.DOMAINS_VERCEL_TOKEN = 'SECRET-VERCEL-TOKEN-123';
    delete process.env.DOMAIN_PROFIT_PERCENT; delete process.env.DOMAIN_MIN_PROFIT_USD; delete process.env.DOMAIN_BUFFER_PERCENT;
});
test.afterEach(() => { R.setTransport(null); delete process.env.KES_PER_USD; delete process.env.DOMAINS_VERCEL_TOKEN; });

test('only a signed-in operator can search', async () => {
    fakeRegistrar();
    assert.equal((await call(domains, { query: { name: 'mybrand' } })).status, 401);
    const adm = await login('admin', 'a@example.com');
    assert.equal((await call(domains, { query: { name: 'mybrand' }, cookie: adm.cookie })).status, 403);
    const op = await login('operator', 'o@example.com');
    assert.equal((await call(domains, { method: 'DELETE', query: { name: 'mybrand' }, cookie: op.cookie })).status, 405);
    assert.equal((await call(domains, { method: 'POST', body: { action: 'nope' }, cookie: op.cookie })).status, 400);
});

test('a badly written name is refused before Vercel is asked', async () => {
    const calls = fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    for (const bad of ['', 'my brand', '-brand', 'brand-', 'a/b', '<script>']) {
        assert.equal((await call(domains, { query: { name: bad }, cookie: op.cookie })).status, 400, bad);
    }
    assert.equal(calls.length, 0);
});

test('results show the operator price in dollars and shillings, with the renewal price', async () => {
    const calls = fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    const r = await call(domains, { query: { name: 'MyBrand.com' }, cookie: op.cookie });   // anything after a dot is ignored
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'mybrand');
    assert.equal(r.body.kes_available, true);
    assert.equal(r.body.rate_credit, false);                       // a typed-in rate needs no credit line
    assert.deepEqual(JSON.parse(calls[0].options.body).domains.slice(0, 3), ['mybrand.com', 'mybrand.net', 'mybrand.org']);

    const by = Object.fromEntries(r.body.results.map(x => [x.domain, x]));
    assert.deepEqual(r.body.results.map(x => x.domain), Object.keys(VERCEL));        // always in the same order
    assert.equal(by['mybrand.com'].price_usd, 13.81);
    assert.equal(by['mybrand.com'].price_kes, 1800);               // 13.81 x 130 = 1795.30 -> 1800
    assert.equal(by['mybrand.com'].renewal_usd, 13.81);
    assert.equal(by['mybrand.site'].price_usd, 4.16);
    assert.equal(by['mybrand.site'].renewal_usd, 31.5);            // the big jump is shown up front
    assert.equal(by['mybrand.site'].renewal_kes, 4100);            // 31.50 x 130 = 4095 -> 4100
    assert.equal(by['mybrand.net'].available, false);
    assert.equal(by['mybrand.net'].price_usd, undefined);
});

test('premium names, multi-year endings and names with no price are not offered', async () => {
    fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    const by = Object.fromEntries((await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).body.results.map(x => [x.domain, x]));
    assert.equal(by['mybrand.online'].offered, false);
    assert.match(by['mybrand.online'].reason, /Premium/);
    assert.equal(by['mybrand.xyz'].offered, false);               // 2-year only
    assert.equal(by['mybrand.store'].offered, false);             // no price from Vercel
    for (const d of ['online', 'xyz', 'store']) assert.equal(by['mybrand.' + d].price_usd, undefined);
});

test('operators never see what Vercel charges, the profit, the rate or the token', async () => {
    fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    const text = JSON.stringify((await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).body);
    for (const word of ['cost', 'profit', 'margin', 'buffer', 'rate"', 'SECRET-VERCEL']) assert.ok(!text.includes(word), word);
    assert.ok(!/"price_usd":11\.25|"renewal_usd":27\b/.test(text), 'Vercel\'s own prices must not appear');
});

test('Vercel\'s token is never sent for a search', async () => {
    const calls = fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie });
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.ok(!JSON.stringify(calls[0]).includes('SECRET-VERCEL'));
});

test('without an exchange rate prices are in dollars only, and the rate credit shows when the rate is live', async () => {
    fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    delete process.env.KES_PER_USD;
    const none = (await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).body;
    assert.equal(none.kes_available, false);
    assert.equal(none.results.find(x => x.domain === 'mybrand.com').price_kes, null);
    assert.equal(none.results.find(x => x.domain === 'mybrand.com').price_usd, 13.81);

    await sql`INSERT INTO fx_rates (pair, rate, source) VALUES ('USD_KES', 129.35, 'open.er-api.com')`;
    const live = (await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).body;
    assert.equal(live.kes_available, true);
    assert.equal(live.rate_credit, true);
    assert.equal(live.results.find(x => x.domain === 'mybrand.com').price_kes, 1790);   // 13.81 x 129.35 = 1786.3 -> 1790
});

test('if Vercel is down the operator gets a plain message, not an error dump', async () => {
    const op = await login('operator', 'o@example.com');
    for (const reply of [new Error('socket hang up'), { status: 500, body: null }, { status: 200, body: { nope: 1 } }]) {
        fakeRegistrar(reply);
        const r = await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie });
        assert.equal(r.status, 502);
        assert.match(r.body.error, /not available right now/);
    }
});

test('searching is limited to 30 times in 10 minutes per operator', async () => {
    fakeRegistrar();
    const op = await login('operator', 'o@example.com');
    for (let i = 0; i < 30; i++) assert.equal((await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).status, 200);
    assert.equal((await call(domains, { query: { name: 'mybrand' }, cookie: op.cookie })).status, 429);
});
