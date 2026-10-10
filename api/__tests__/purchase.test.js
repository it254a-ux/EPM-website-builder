// After payment: buying the domain from Vercel, switching the site, and every way that can go wrong.
// Real handlers + real SQL (in-memory Postgres). Safaricom, the registrar and Vercel's project API are fakes.
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
const admin = require('../admin');
const cronFx = require('../cron-fx');
const A = require('../_lib/auth');
const M = require('../_lib/mpesa');
const R = require('../_lib/vercel-registrar');
const VD = require('../_lib/vercel-domains');
const FX = require('../_lib/fx');
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
function call(handler, { method = 'GET', query = {}, body, cookie, headers: extra } = {}) {
    return new Promise(resolve => {
        const headers = { host: HOST, 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https', ...(extra || {}) };
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

// ---- fakes ----
let buyCalls, vercelCalls, buyReply;
function fakes() {
    let n = 0;
    M.setTransport(async url => {
        if (url.includes('/oauth/')) return { status: 200, body: { access_token: 'tok', expires_in: '3599' } };
        if (url.includes('processrequest')) { n++; return { status: 200, body: { MerchantRequestID: 'mr' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0' } }; }
        return { status: 200, body: { ResultCode: '0', ResultDesc: 'ok' } };                 // payment confirmed
    });
    buyCalls = []; buyReply = { status: 200, body: { orderId: 'ord_123', _links: {} } };
    R.setTransport(async (url, options) => {
        if (url.endsWith('/search')) return { status: 200, body: { results: JSON.parse(options.body).domains.map(d => ({ domain: d, available: d === 'mybrand.com', years: 1, price: 11.25, renewalPrice: 11.25, premium: false })) } };
        buyCalls.push({ url, options });
        if (buyReply instanceof Error) throw buyReply;
        return typeof buyReply === 'function' ? buyReply() : buyReply;
    });
    vercelCalls = [];
    VD.setTransport(async (url, options) => { vercelCalls.push({ url, options }); return { status: 200, body: { name: 'x', verified: true } }; });
}
const CONTACT = { first_name: 'Julia', last_name: 'Wanjiru', address1: '12 Moi Avenue', city: 'Nairobi', state: 'Nairobi', zip: '00100', country: 'KE' };
async function paidOrder() {                           // an operator places an order and Safaricom reports success
    const op = await login('operator', 'o@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Shop', subdomain: 'shop' } });
    const placed = await call(domains, { method: 'POST', cookie: op.cookie, body: { action: 'order', domain: 'mybrand.com', phone: '0712345678', contact: CONTACT } });
    assert.equal(placed.status, 201);
    return { op, id: placed.body.order.id };
}
const report = () => call(payCallback, { method: 'POST', query: { k: SECRET }, body: { Body: { stkCallback: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1800 }, { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' }] } } } } });
const row = async id => (await sql`SELECT * FROM domain_orders WHERE id = ${id}`)[0];
const site = async () => (await sql`SELECT * FROM sites`)[0];

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, PLATFORM_ROOT_DOMAIN: 'free.test', KES_PER_USD: '130',
        MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'K', MPESA_CONSUMER_SECRET: 'S', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'P', MPESA_CALLBACK_SECRET: SECRET,
        DOMAINS_VERCEL_TOKEN: TOKEN, DOMAINS_VERCEL_PROJECT: 'trading-site', CRON_SECRET: 'cron-xyz' });
    delete process.env.DOMAINS_VERCEL_TEAM;
    fakes();
});
test.afterEach(() => {
    M.setTransport(null); R.setTransport(null); VD.setTransport(null); FX.setTransport(null);
    for (const k of ['KES_PER_USD', 'MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'DOMAINS_VERCEL_TOKEN', 'DOMAINS_VERCEL_PROJECT', 'CRON_SECRET']) delete process.env[k];
});

test('payment confirmed: the domain is bought with auto-renew OFF, the price guard, and the owner\'s details', async () => {
    const { op, id } = await paidOrder();
    assert.equal((await report()).status, 200);
    assert.equal(buyCalls.length, 1);
    assert.equal(buyCalls[0].url, 'https://api.vercel.com/v1/registrar/domains/mybrand.com/buy');
    assert.equal(buyCalls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
    const sent = JSON.parse(buyCalls[0].options.body);
    assert.equal(sent.autoRenew, false);
    assert.equal(sent.years, 1);
    assert.equal(sent.expectedPrice, 11.25);                   // Vercel refuses if its price moved
    assert.deepEqual(sent.contactInformation, { firstName: 'Julia', lastName: 'Wanjiru', email: 'o@example.com', phone: '+254712345678', address1: '12 Moi Avenue', city: 'Nairobi', state: 'Nairobi', zip: '00100', country: 'KE' });

    const o = await row(id);
    assert.equal(o.status, 'completed');
    assert.equal(o.vercel_order_id, 'ord_123');
    assert.equal(o.failure_reason, null);

    const s = await site();
    assert.equal(s.domain, 'mybrand.com');
    assert.equal(s.plan, 'custom');
    assert.equal(s.status, 'active');
    assert.equal(s.domain_bought_here, true);
    assert.equal(s.custom_domain_requested, null);
    const days = (new Date(s.domain_expires_at) - Date.now()) / 86400000;
    assert.ok(days > 364 && days < 366, 'expires in about a year');
    assert.equal((await sql`SELECT plan FROM site_rate_history WHERE site_id = ${s.id} ORDER BY id DESC LIMIT 1`)[0].plan, 'custom');
    assert.ok((await sql`SELECT event FROM site_events WHERE site_id = ${s.id}`).some(e => e.event === 'domain_bought'));
    assert.equal(vercelCalls.length, 1);
    assert.equal(vercelCalls[0].url, 'https://api.vercel.com/v10/projects/trading-site/domains');
    assert.equal(JSON.parse(vercelCalls[0].options.body).name, 'mybrand.com');

    const seen = (await call(domains, { query: { order: String(id) }, cookie: op.cookie })).body.order;
    assert.equal(seen.status, 'completed');
    for (const w of ['cost', 'profit', TOKEN, 'ord_123']) assert.ok(!JSON.stringify(seen).includes(w), w);
});

test('the registrar says no (price moved, name taken): nothing is switched and the customer is owed a refund', async () => {
    for (const reply of [
        { status: 400, body: { status: 400, code: 'expected_price_mismatch', message: 'The expected price does not match.' } },
        { status: 400, body: { status: 400, code: 'domain_not_available', message: 'The domain is not available.' } },
    ]) {
        await freshDb(); fakes(); buyReply = reply;
        const { id } = await paidOrder();
        await report();
        const o = await row(id);
        assert.equal(o.status, 'refund_due');
        assert.match(o.failure_reason, /expected_price_mismatch|domain_not_available/);
        assert.equal((await site()).plan, 'free');
        assert.equal((await site()).domain_bought_here, false);
    }
});

test('no answer from Vercel: we do NOT retry or refund, because it may have gone through', async () => {
    buyReply = new Error('socket hang up');
    const { id } = await paidOrder();
    await report();
    assert.equal((await row(id)).status, 'check_needed');
    assert.equal((await site()).plan, 'free');
    await DO.sweep(sql);                                       // the daily sweep must leave it alone
    assert.equal(buyCalls.length, 1);
    assert.equal((await row(id)).status, 'check_needed');

    await freshDb(); fakes(); buyReply = { status: 500, body: { code: 'internal_server_error', message: 'oops' } };
    const second = await paidOrder();
    await report();
    assert.equal((await row(second.id)).status, 'check_needed');
});

test('a rate limit is retried later and then succeeds; five failed tries hand it to a person', async () => {
    buyReply = { status: 429, body: { code: 'too_many_requests', message: 'slow down' } };
    const { id } = await paidOrder();
    await report();
    let o = await row(id);
    assert.equal(o.status, 'paid'); assert.equal(o.attempts, 1);
    buyReply = { status: 200, body: { orderId: 'ord_9' } };
    await DO.sweep(sql);
    o = await row(id);
    assert.equal(o.status, 'completed'); assert.equal(o.attempts, 2);

    await freshDb(); fakes(); buyReply = { status: 429, body: { code: 'too_many_requests', message: 'slow down' } };
    const b = await paidOrder();
    await report();
    for (let i = 0; i < 6; i++) await DO.sweep(sql);
    o = await row(b.id);
    assert.equal(o.status, 'check_needed');
    assert.equal(o.attempts, 5);
});

test('a missing or refused Vercel token keeps the paid order waiting, and a fix completes it', async () => {
    delete process.env.DOMAINS_VERCEL_TOKEN;
    const { id } = await paidOrder();
    await report();
    let o = await row(id);
    assert.equal(o.status, 'paid');
    assert.match(o.failure_reason, /DOMAINS_VERCEL_TOKEN/);
    assert.equal(buyCalls.length, 0);
    process.env.DOMAINS_VERCEL_TOKEN = TOKEN;
    await DO.sweep(sql);
    assert.equal((await row(id)).status, 'completed');
});

test('two things finishing the same order at once buy the domain only once', async () => {
    const { id } = await paidOrder();
    await sql`UPDATE domain_orders SET status = 'paid' WHERE id = ${id}`;
    await Promise.all([DO.fulfil(sql, id), DO.fulfil(sql, id), DO.fulfil(sql, id), report()]);
    assert.equal(buyCalls.length, 1);
    assert.equal((await row(id)).status, 'completed');
});

test('bought, but the site could not be attached to Vercel: the order still completes and says what is left', async () => {
    delete process.env.DOMAINS_VERCEL_PROJECT;
    const { id } = await paidOrder();
    await report();
    const o = await row(id);
    assert.equal(o.status, 'completed');
    assert.match(o.failure_reason, /Not yet on the Vercel project/);
    assert.equal((await site()).domain, 'mybrand.com');
});

test('an order stuck in "buying" for 5 minutes is flagged for a person, never retried', async () => {
    const { id } = await paidOrder();
    await sql`UPDATE domain_orders SET status = 'buying', updated_at = now() - interval '6 minutes' WHERE id = ${id}`;
    const r = await DO.sweep(sql);
    assert.equal(r.stuck, 1);
    assert.equal((await row(id)).status, 'check_needed');
    assert.equal(buyCalls.length, 0);
});

test('the operator\'s screen polling also finishes a paid order whose callback was lost', async () => {
    const { op, id } = await paidOrder();
    await sql`UPDATE domain_orders SET updated_at = now() - interval '1 minute' WHERE id = ${id}`;
    const r = await call(domains, { query: { order: String(id) }, cookie: op.cookie });
    assert.equal(r.body.order.status, 'completed');
    assert.equal(buyCalls.length, 1);
});

test('the daily visit finishes stuck paid orders as well as updating the exchange rate', async () => {
    const { id } = await paidOrder();
    await sql`UPDATE domain_orders SET status = 'paid' WHERE id = ${id}`;
    FX.setTransport(async () => ({ status: 200, body: { result: 'success', rates: { KES: 129.4 } } }));
    const r = await call(cronFx, { method: 'GET', headers: { authorization: 'Bearer cron-xyz' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.rate, 129.4);
    assert.equal(r.body.sweep.retried, 1);
    assert.equal((await row(id)).status, 'completed');
});

test('admin: see the cost, mark refunds (with a code), retry, and confirm a manual check', async () => {
    const adm = await login('admin', 'a@example.com');
    buyReply = new Error('timeout');
    const { op, id } = await paidOrder();
    await report();                                                               // -> check_needed
    const post = (body, cookie = adm.cookie) => call(admin, { method: 'POST', cookie, body });

    assert.equal((await post({ action: 'order_retry', id }, op.cookie)).status, 403);
    const list = (await call(admin, { query: { resource: 'domain_orders' }, cookie: adm.cookie })).body.orders;
    assert.equal(list[0].id, id);
    assert.equal(list[0].status, 'check_needed');
    assert.equal(list[0].cost_usd, 11.25);                                         // the admin sees what Vercel charges

    // The person checked Vercel: the domain IS registered.
    const done = await post({ action: 'order_complete', id });
    assert.equal(done.status, 200);
    assert.equal((await row(id)).status, 'completed');
    assert.equal((await site()).domain, 'mybrand.com');
    assert.equal((await post({ action: 'order_complete', id })).status, 409);       // cannot be done twice

    // Another order: refund path needs a reference.
    await freshDb(); fakes();
    const adm2 = await login('admin', 'a2@example.com');
    buyReply = { status: 400, body: { code: 'domain_not_available', message: 'taken' } };
    const second = await paidOrder();
    await report();
    assert.equal((await row(second.id)).status, 'refund_due');
    assert.equal((await post({ action: 'order_refunded', id: second.id, reference: 'x' }, adm2.cookie)).status, 400);
    assert.equal((await post({ action: 'order_refunded', id: second.id, reference: 'SJK81PQ2LM' }, adm2.cookie)).status, 200);
    const refunded = await row(second.id);
    assert.equal(refunded.status, 'refunded'); assert.equal(refunded.refund_reference, 'SJK81PQ2LM');
    assert.equal((await post({ action: 'order_refunded', id: second.id, reference: 'SJK81PQ2LM' }, adm2.cookie)).status, 409);
    assert.equal((await post({ action: 'order_retry', id: second.id }, adm2.cookie)).status, 409);   // refunds are never re-bought
});

test('admin retry buys it now', async () => {
    const adm = await login('admin', 'a@example.com');
    buyReply = new Error('timeout');
    const { id } = await paidOrder();
    await report();
    buyReply = { status: 200, body: { orderId: 'ord_77' } };
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'order_retry', id } });
    assert.equal(r.status, 200);
    assert.match(r.body.notice, /registered/);
    assert.equal((await row(id)).status, 'completed');
    assert.equal((await site()).domain, 'mybrand.com');
});

test('admin sees the margin on each finished sale and the totals; operators never do', async () => {
    const adm = await login('admin', 'a@example.com');
    const { op, id } = await paidOrder();
    await report();                                                       // paid, bought, completed
    const list = (await call(admin, { query: { resource: 'domain_orders' }, cookie: adm.cookie })).body;
    assert.equal(list.orders[0].id, id);
    assert.equal(list.orders[0].status, 'completed');
    assert.equal(list.orders[0].margin_usd, 2.56);                        // 13.81 paid by the operator minus 11.25 charged by Vercel
    assert.equal(list.totals.orders, 1);
    assert.equal(list.totals.revenue_kes, 1800);
    assert.equal(list.totals.margin_usd, 2.56);
    const seen = JSON.stringify((await call(domains, { query: { orders: '1' }, cookie: op.cookie })).body);
    assert.ok(!/margin|cost/.test(seen));
});
