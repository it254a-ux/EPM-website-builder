// Domain expiry: what the operator sees, pausing an unpaid site, and renewing by M-Pesa.
// Real handlers + real SQL (in-memory Postgres). Safaricom and Vercel are replaced by fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const domains = require('../domains');
const payCallback = require('../pay-callback');
const mySite = require('../my-site');
const A = require('../_lib/auth');
const M = require('../_lib/mpesa');
const R = require('../_lib/vercel-registrar');
const VD = require('../_lib/vercel-domains');
const DO = require('../_lib/domain-orders');

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

let renewCalls, priceReply, renewReply;
function fakes() {
    let n = 0;
    M.setTransport(async url => {
        if (url.includes('/oauth/')) return { status: 200, body: { access_token: 'tok', expires_in: '3599' } };
        if (url.includes('processrequest')) { n++; return { status: 200, body: { MerchantRequestID: 'mr' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0' } }; }
        return { status: 200, body: { ResultCode: '0', ResultDesc: 'ok' } };
    });
    renewCalls = []; priceReply = { status: 200, body: { years: 1, purchasePrice: 11.25, renewalPrice: '11.25', transferPrice: 11.25 } };
    renewReply = { status: 200, body: { orderId: 'ren_1', _links: {} } };
    R.setTransport(async (url, options) => {
        if (url.includes('/price')) { if (priceReply instanceof Error) throw priceReply; return priceReply; }
        if (url.endsWith('/renew')) { renewCalls.push({ url, options }); if (renewReply instanceof Error) throw renewReply; return renewReply; }
        throw new Error('unexpected ' + url);
    });
    VD.setTransport(async () => ({ status: 200, body: { verified: true } }));
}
// An operator whose domain we sold, expiring in `days` days (negative = already expired).
async function boughtSite(days, { paused = false } = {}) {
    const op = await login('operator', 'o@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Shop', subdomain: 'shop' } });
    const site = (await sql`SELECT id FROM sites`)[0];
    await sql`UPDATE sites SET plan = 'custom', domain = 'mybrand.com', domain_bought_here = true,
                               domain_expires_at = now() + (${days} || ' days')::interval, domain_paused_at = ${paused ? new Date() : null},
                               status = ${paused ? 'suspended' : 'active'} WHERE id = ${site.id}`;
    await sql`INSERT INTO domain_orders (owner_id, site_id, kind, domain, price_usd_cents, price_kes, cost_usd_cents, renewal_usd_cents, renewal_cost_cents, phone, expires_at, status, completed_at)
              VALUES (${op.id}, ${site.id}, 'purchase', 'mybrand.com', 1381, 1800, 1125, 1381, 1125, '254712345678', now(), 'completed', now())`;
    return { op, siteId: site.id };
}
const post = (op, body) => call(domains, { method: 'POST', cookie: op.cookie, body });
const report = id => call(payCallback, { method: 'POST', query: { k: SECRET }, body: { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: id, ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1800 }, { Name: 'MpesaReceiptNumber', Value: 'RCPT' + id.slice(-1) + 'ABCDEF' }] } } } } });
const site = async () => (await sql`SELECT * FROM sites`)[0];

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, PLATFORM_ROOT_DOMAIN: 'free.test', KES_PER_USD: '130',
        MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'K', MPESA_CONSUMER_SECRET: 'S', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'P', MPESA_CALLBACK_SECRET: SECRET,
        DOMAINS_VERCEL_TOKEN: TOKEN, DOMAINS_VERCEL_PROJECT: 'trading-site' });
    fakes();
});
test.afterEach(() => {
    M.setTransport(null); R.setTransport(null); VD.setTransport(null);
    for (const k of ['KES_PER_USD', 'MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'DOMAINS_VERCEL_TOKEN', 'DOMAINS_VERCEL_PROJECT']) delete process.env[k];
});

test('the operator\'s site shows when a domain we sold expires, and nothing for other domains', async () => {
    const free = await login('operator', 'f@example.com');
    await call(mySite, { method: 'POST', cookie: free.cookie, body: { name: 'Free', subdomain: 'free1' } });
    assert.equal((await call(mySite, { cookie: free.cookie })).body.site.renewal, null);

    const cases = [[200, 'ok', false], [30, 'soon', false], [5, 'soon', false], [-3, 'expired', false], [-3, 'expired', true]];
    for (const [days, state, paused] of cases) {
        await freshDb(); fakes();
        const { op } = await boughtSite(days, { paused });
        const r = (await call(mySite, { cookie: op.cookie })).body.site.renewal;
        assert.equal(r.state, state, `${days} days`);
        assert.equal(r.paused, paused);
        assert.ok(Math.abs(r.days_left - days) <= 1);
    }
});

test('an unpaid expired domain pauses the site; nothing else is touched; running again changes nothing', async () => {
    const { siteId } = await boughtSite(-1);
    // a site on a free address, one whose domain was not bought here, and one an admin suspended: none may be touched
    const other = await login('operator', 'x@example.com');
    await call(mySite, { method: 'POST', cookie: other.cookie, body: { name: 'Other', subdomain: 'other' } });
    const o2 = (await sql`SELECT id FROM sites WHERE id <> ${siteId}`)[0].id;
    await sql`UPDATE sites SET domain_bought_here = false, domain_expires_at = now() - interval '5 days' WHERE id = ${o2}`;

    assert.equal(await DO.pauseExpired(sql), 1);
    const s = await site.call(null);
    const mine = (await sql`SELECT * FROM sites WHERE id = ${siteId}`)[0];
    assert.equal(mine.status, 'suspended');
    assert.ok(mine.domain_paused_at);
    assert.equal((await sql`SELECT status FROM sites WHERE id = ${o2}`)[0].status, 'active');
    assert.ok((await sql`SELECT event FROM site_events WHERE site_id = ${siteId}`).some(e => e.event === 'domain_expired_paused'));
    assert.equal(await DO.pauseExpired(sql), 0);

    await sql`UPDATE sites SET status = 'active', domain_paused_at = NULL, domain_expires_at = now() - interval '2 days' WHERE id = ${siteId}`;
    await sql`UPDATE sites SET status = 'suspended' WHERE id = ${siteId}`;                // an admin suspension
    assert.equal(await DO.pauseExpired(sql), 0);
    assert.equal((await sql`SELECT domain_paused_at FROM sites WHERE id = ${siteId}`)[0].domain_paused_at, null);
    assert.ok(s);
});

test('a domain not yet expired is left running', async () => {
    await boughtSite(1);
    assert.equal(await DO.pauseExpired(sql), 0);
    assert.equal((await site()).status, 'active');
});

test('the renewal quote uses Vercel\'s live price, falls back to the purchase-time price, and hides your cost', async () => {
    const { op } = await boughtSite(20);
    priceReply = { status: 200, body: { years: 1, purchasePrice: 11.25, renewalPrice: 30, transferPrice: 11.25 } };
    let q = (await call(domains, { query: { renewal: '1' }, cookie: op.cookie })).body;
    assert.equal(q.domain, 'mybrand.com');
    assert.equal(q.can_renew, true);
    assert.equal(q.price_usd, 35);                              // 30 + 12% = 33.60 -> /0.96 = 35.00
    assert.equal(q.price_kes, 4550);
    for (const w of ['cost', 'profit', TOKEN]) assert.ok(!JSON.stringify(q).includes(w), w);

    priceReply = new Error('timeout');
    q = (await call(domains, { query: { renewal: '1' }, cookie: op.cookie })).body;
    assert.equal(q.price_usd, 13.81);                           // back to the 11.25 expected at purchase

    await sql`DELETE FROM domain_orders`;
    assert.equal((await call(domains, { query: { renewal: '1' }, cookie: op.cookie })).status, 503);
});

test('renewing is only for domains bought here, and only in the last 90 days', async () => {
    const free = await login('operator', 'f@example.com');
    await call(mySite, { method: 'POST', cookie: free.cookie, body: { name: 'Free', subdomain: 'free1' } });
    assert.equal((await call(domains, { query: { renewal: '1' }, cookie: free.cookie })).status, 400);
    assert.equal((await post(free, { action: 'renew', phone: '0712345678' })).status, 400);

    await freshDb(); fakes();
    const { op } = await boughtSite(200);
    assert.equal((await call(domains, { query: { renewal: '1' }, cookie: op.cookie })).body.can_renew, false);
    const early = await post(op, { action: 'renew', phone: '0712345678' });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /last 90 days/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM domain_orders WHERE kind = 'renewal'`)[0].n, 0);
});

test('renewing: pay, Vercel renews for one year with the price guard, the expiry moves out a year from the OLD date', async () => {
    const { op, siteId } = await boughtSite(20);
    const before = new Date((await site()).domain_expires_at).getTime();
    const placed = await post(op, { action: 'renew', phone: '0712345678' });
    assert.equal(placed.status, 201);
    assert.equal(placed.body.order.kind, 'renewal');
    assert.equal(placed.body.order.price_kes, 1800);
    assert.equal(renewCalls.length, 0, 'nothing is bought before payment');

    await report('ws_CO_1');
    assert.equal(renewCalls.length, 1);
    assert.equal(renewCalls[0].url, 'https://api.vercel.com/v1/registrar/domains/mybrand.com/renew');
    assert.equal(renewCalls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(renewCalls[0].options.body), { years: 1, expectedPrice: 11.25 });

    const o = (await sql`SELECT * FROM domain_orders WHERE kind = 'renewal'`)[0];
    assert.equal(o.status, 'completed');
    const after = new Date((await site()).domain_expires_at).getTime();
    const gainDays = (after - before) / 86400000;
    assert.ok(gainDays > 364 && gainDays < 367, 'one year added to the old date, not to today');
    assert.ok((await sql`SELECT event FROM site_events WHERE site_id = ${siteId}`).some(e => e.event === 'domain_renewed'));
});

test('a paused site comes back the moment the renewal goes through', async () => {
    const { op, siteId } = await boughtSite(-10);
    await DO.pauseExpired(sql);
    assert.equal((await site()).status, 'suspended');

    const placed = await post(op, { action: 'renew', phone: '0712345678' });          // late renewal still allowed
    assert.equal(placed.status, 201);
    assert.equal((await site()).status, 'suspended', 'still paused until paid');
    await report('ws_CO_1');
    const s = await site();
    assert.equal(s.status, 'active');
    assert.equal(s.domain_paused_at, null);
    assert.ok(new Date(s.domain_expires_at) > new Date());
    assert.ok((await sql`SELECT event FROM site_events WHERE site_id = ${siteId}`).some(e => e.event === 'domain_renewed_resumed'));
});

test('if the renewal cannot be done after payment, the site stays as it was and the customer is owed a refund', async () => {
    const { op } = await boughtSite(-2);
    await DO.pauseExpired(sql);
    renewReply = { status: 400, body: { status: 400, code: 'expected_price_mismatch', message: 'The expected price passed does not match the actual price.' } };
    await post(op, { action: 'renew', phone: '0712345678' });
    await report('ws_CO_1');
    const o = (await sql`SELECT * FROM domain_orders WHERE kind = 'renewal'`)[0];
    assert.equal(o.status, 'refund_due');
    assert.match(o.failure_reason, /expected_price_mismatch/);
    assert.equal((await site()).status, 'suspended');

    await freshDb(); fakes(); renewReply = new Error('timeout');
    const again = await boughtSite(-2);
    await DO.pauseExpired(sql);
    await post(again.op, { action: 'renew', phone: '0712345678' });
    await report('ws_CO_1');
    assert.equal((await sql`SELECT status FROM domain_orders WHERE kind = 'renewal'`)[0].status, 'check_needed');
    assert.equal((await site()).status, 'suspended');
});

test('only one renewal can be in progress, and payments must be switched on', async () => {
    const { op } = await boughtSite(10);
    renewReply = new Error('timeout');
    await post(op, { action: 'renew', phone: '0712345678' });
    await report('ws_CO_1');                                                          // -> check_needed
    const second = await post(op, { action: 'renew', phone: '0712345678' });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already being processed/);

    await freshDb(); fakes();
    const b = await boughtSite(10);
    delete process.env.MPESA_PASSKEY;
    assert.equal((await post(b.op, { action: 'renew', phone: '0712345678' })).status, 503);
    process.env.MPESA_PASSKEY = 'P';
    assert.equal((await post(b.op, { action: 'renew', phone: 'abc' })).status, 400);
});

test('the full story: expires, is paused by the daily visit, the operator renews, the site is live again', async () => {
    const { op } = await boughtSite(-1);
    const sweep = await DO.sweep(sql);
    assert.equal(sweep.paused, 1);
    assert.equal((await call(mySite, { cookie: op.cookie })).body.site.renewal.paused, true);
    await post(op, { action: 'renew', phone: '0712345678' });
    await report('ws_CO_1');
    const view = (await call(mySite, { cookie: op.cookie })).body.site;
    assert.equal(view.status, 'active');
    assert.equal(view.renewal.paused, false);
    assert.equal(view.renewal.state, 'ok');
});
