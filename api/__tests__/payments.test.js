// Paying for a domain by M-Pesa: placing the order, Safaricom's report, and the safety rules around money.
// Real handlers + real SQL (in-memory Postgres). Safaricom and the domain registrar are replaced by fakes.
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
const DO = require('../_lib/domain-orders');

const HOST = 'builder.test';
const SECRET = 'callback-secret-xyz';

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
async function operatorWithSite(email, sub) {
    const op = await login('operator', email);
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Shop ' + sub, subdomain: sub } });
    return op;
}

// ---- fakes ----
let queryReply, mpesaCalls;
const PAID = { status: 200, body: { ResultCode: '0', ResultDesc: 'ok' } };
const PENDING = { status: 500, body: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } };
const CANCELLED = { status: 200, body: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' } };
function fakeMpesa({ pushFails = false } = {}) {
    mpesaCalls = []; let n = 0; queryReply = PAID;
    M.setTransport(async (url, options) => {
        mpesaCalls.push({ url, options });
        if (url.includes('/oauth/')) return { status: 200, body: { access_token: 'tok', expires_in: '3599' } };
        if (url.includes('processrequest')) { if (pushFails) return { status: 400, body: { errorCode: 'x' } }; n++; return { status: 200, body: { MerchantRequestID: 'mr' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0' } }; }
        if (url.includes('stkpushquery')) return queryReply;
        throw new Error('unexpected ' + url);
    });
}
const VERCEL = { 'mybrand.com': { available: true, years: 1, price: 11.25, renewalPrice: 11.25, premium: false },
                 'mybrand.net': { available: false }, 'mybrand.org': { available: true, years: 1, price: 9.99, renewalPrice: 10.99, premium: false } };
function fakeRegistrar() {
    R.setTransport(async (url, options) => ({ status: 200, body: { results: JSON.parse(options.body).domains.map(d => ({ domain: d, ...(VERCEL[d] || { available: false }) })) } }));
}
const CONTACT = { first_name: 'Julia', last_name: 'Wanjiru', address1: '12 Moi Avenue', city: 'Nairobi', state: 'Nairobi', zip: '00100', country: 'KE' };
const order = (op, over = {}) => call(domains, { method: 'POST', cookie: op.cookie, body: { action: 'order', domain: 'mybrand.com', phone: '0712345678', contact: CONTACT, ...over } });
const cbBody = (checkoutId, { code = 0, amount = 1800, receipt = 'NLJ7RT61SV' } = {}) => ({ Body: { stkCallback: { MerchantRequestID: 'mr', CheckoutRequestID: checkoutId, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'Request cancelled by user',
    ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }] } } : {}) } } });
const report = (checkoutId, opts, k = SECRET) => call(payCallback, { method: 'POST', query: { k }, body: cbBody(checkoutId, opts) });
const row = async id => (await sql`SELECT * FROM domain_orders WHERE id = ${id}`)[0];
const ageIt = id => sql`UPDATE domain_orders SET updated_at = now() - interval '1 minute' WHERE id = ${id}`;

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, PLATFORM_ROOT_DOMAIN: 'free.test', KES_PER_USD: '130',
        MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'KEY', MPESA_CONSUMER_SECRET: 'SEC', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'PASS', MPESA_CALLBACK_SECRET: SECRET });
    delete process.env.DOMAIN_PROFIT_PERCENT; delete process.env.DOMAIN_MIN_PROFIT_USD; delete process.env.DOMAIN_BUFFER_PERCENT;
    fakeMpesa(); fakeRegistrar();
});
test.afterEach(() => {
    M.setTransport(null); R.setTransport(null);
    for (const k of ['KES_PER_USD', 'MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET']) delete process.env[k];
});

test('placing an order sends the prompt, fixes the price, and tells the operator nothing private', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const r = await order(op);
    assert.equal(r.status, 201);
    assert.equal(r.body.order.status, 'awaiting_payment');
    assert.equal(r.body.order.price_kes, 1800);
    assert.equal(r.body.order.price_usd, 13.81);

    const push = mpesaCalls.find(c => c.url.includes('processrequest'));
    const sent = JSON.parse(push.options.body);
    assert.equal(sent.Amount, 1800);
    assert.equal(sent.PartyA, '254712345678');
    assert.equal(sent.CallBackURL, `https://${HOST}/api/pay-callback?k=${SECRET}`);

    const db = await row(r.body.order.id);
    assert.equal(db.cost_usd_cents, 1125);                      // your cost is kept on your side only
    assert.equal(db.mpesa_checkout_id, 'ws_CO_1');
    assert.equal(db.contact.email, 'o@example.com');
    assert.equal(db.contact.phone, '+254712345678');

    const text = JSON.stringify(r.body);
    for (const w of ['cost', 'profit', 'margin', 'buffer', 'fx_rate', SECRET, 'ws_CO_1']) assert.ok(!text.includes(w), w);
});

test('bad details are refused before anything is charged', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const bad = [
        [{ phone: '123' }, 'phone'], [{ contact: { ...CONTACT, first_name: '' } }, 'first_name'], [{ contact: { ...CONTACT, country: 'Kenya' } }, 'country'],
        [{ domain: 'mybrand.ke' }, null], [{ domain: 'not a domain' }, null],
    ];
    for (const [over, field] of bad) {
        const r = await order(op, over);
        assert.equal(r.status, 400, JSON.stringify(over));
        if (field) assert.ok(r.body.fields[field], field);
    }
    assert.equal(mpesaCalls.filter(c => c.url.includes('processrequest')).length, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM domain_orders`)[0].n, 0);
});

test('payments off, no rate, no site, own-domain site, taken name: each gets a clear refusal', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    delete process.env.MPESA_PASSKEY;
    assert.equal((await order(op)).status, 503);
    process.env.MPESA_PASSKEY = 'PASS';
    delete process.env.KES_PER_USD;
    assert.equal((await order(op)).status, 503);
    process.env.KES_PER_USD = '130';
    assert.equal((await order(op, { domain: 'mybrand.net' })).status, 409);              // taken at the registrar
    const noSite = await login('operator', 'n@example.com');
    assert.equal((await order(noSite)).status, 400);
    await sql`UPDATE sites SET plan = 'custom' WHERE owner_id = ${op.id}`;
    assert.equal((await order(op)).status, 400);
    const adm = await login('admin', 'a@example.com');
    assert.equal((await order(adm)).status, 403);
    assert.equal((await call(domains, { method: 'POST', body: {} })).status, 401);
});

test('if M-Pesa cannot send the prompt, the order is cancelled and the name is free again', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    fakeMpesa({ pushFails: true });
    const r = await order(op);
    assert.equal(r.status, 502);
    assert.equal((await sql`SELECT status FROM domain_orders`)[0].status, 'cancelled');
    fakeMpesa();
    assert.equal((await order(op)).status, 201);
});

test('a name can only be in one open order, and other operators cannot see my orders', async () => {
    const a = await operatorWithSite('a@example.com', 'shopa'), b = await operatorWithSite('b@example.com', 'shopb');
    const first = await order(a);
    assert.equal(first.status, 201);
    const clash = await order(b);
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /Someone else/);
    assert.equal((await call(domains, { query: { order: String(first.body.order.id) }, cookie: b.cookie })).status, 404);
    assert.equal((await call(domains, { query: { order: String(first.body.order.id) }, cookie: a.cookie })).status, 200);
    assert.equal((await call(domains, { query: { orders: '1' }, cookie: b.cookie })).body.orders.length, 0);
});

test('Safaricom\'s report: wrong secret is refused, a good one marks the order paid only after Safaricom confirms', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const { body: { order: o } } = await order(op);

    assert.equal((await report('ws_CO_1', {}, 'wrong')).status, 401);
    assert.equal((await call(payCallback, { method: 'POST', body: cbBody('ws_CO_1') })).status, 401);
    assert.equal((await call(payCallback, { method: 'GET', query: { k: SECRET } })).status, 405);
    assert.equal((await row(o.id)).status, 'awaiting_payment');

    const r = await report('ws_CO_1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    const db = await row(o.id);
    assert.equal(db.status, 'paid');
    assert.equal(db.mpesa_receipt, 'NLJ7RT61SV');
    assert.equal(db.paid_kes, 1800);
    assert.ok(mpesaCalls.some(c => c.url.includes('stkpushquery')), 'Safaricom was asked to confirm');
});

test('the same report arriving twice changes nothing the second time', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const { body: { order: o } } = await order(op);
    await report('ws_CO_1');
    const before = await row(o.id);
    const again = await report('ws_CO_1');
    assert.equal(again.status, 200);
    const after = await row(o.id);
    assert.equal(after.status, 'paid');
    assert.equal(after.paid_at.toISOString(), before.paid_at.toISOString());
});

test('a success report is not trusted if Safaricom says the payment failed or cannot yet say', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const { body: { order: o } } = await order(op);

    queryReply = CANCELLED;
    await report('ws_CO_1');
    assert.equal((await row(o.id)).status, 'cancelled');                     // a fake "success" is not enough

    const o2 = (await order(op)).body.order;
    queryReply = PENDING;
    await report('ws_CO_2', { receipt: 'ABC9999999' });
    let db = await row(o2.id);
    assert.equal(db.status, 'awaiting_payment');                             // noted, not yet paid
    assert.equal(db.mpesa_receipt, 'ABC9999999');

    // The operator's screen asks again; Safaricom now confirms.
    queryReply = PAID; await ageIt(o2.id);
    const polled = await call(domains, { query: { order: String(o2.id) }, cookie: op.cookie });
    assert.equal(polled.body.order.status, 'paid');
    db = await row(o2.id);
    assert.equal(db.mpesa_receipt, 'ABC9999999');
});

test('polling asks Safaricom at most once every 10 seconds', async () => {
    const op = await operatorWithSite('o@example.com', 'shop');
    const { body: { order: o } } = await order(op);
    queryReply = PENDING; await ageIt(o.id);
    const count = () => mpesaCalls.filter(c => c.url.includes('stkpushquery')).length;
    await call(domains, { query: { order: String(o.id) }, cookie: op.cookie });
    await call(domains, { query: { order: String(o.id) }, cookie: op.cookie });
    await call(domains, { query: { order: String(o.id) }, cookie: op.cookie });
    assert.equal(count(), 1);
});

test('a cancelled prompt frees the name for someone else', async () => {
    const a = await operatorWithSite('a@example.com', 'shopa'), b = await operatorWithSite('b@example.com', 'shopb');
    const { body: { order: o } } = await order(a);
    await report('ws_CO_1', { code: 1032 });
    assert.equal((await row(o.id)).status, 'cancelled');
    assert.equal((await order(b)).status, 201);
});

test('paying the wrong amount, or reusing a receipt, sends the order to refund_due', async () => {
    const a = await operatorWithSite('a@example.com', 'shopa'), b = await operatorWithSite('b@example.com', 'shopb');
    const first = (await order(a)).body.order;
    await report('ws_CO_1', { amount: 1500 });
    let db = await row(first.id);
    assert.equal(db.status, 'refund_due');
    assert.match(db.failure_reason, /did not match/);

    const second = (await order(b, { domain: 'mybrand.org' })).body.order;
    await report('ws_CO_2', { amount: second.price_kes, receipt: 'NLJ7RT61SV' });          // same receipt as the first order
    db = await row(second.id);
    assert.equal(db.status, 'refund_due');
    assert.match(db.failure_reason, /receipt|taken|another order/i);
});

test('a late payment on an expired order still counts, unless someone else now holds the name', async () => {
    const a = await operatorWithSite('a@example.com', 'shopa');
    const { body: { order: o } } = await order(a);
    await sql`UPDATE domain_orders SET expires_at = now() - interval '1 minute' WHERE id = ${o.id}`;
    await DO.expireStale(sql);
    assert.equal((await row(o.id)).status, 'expired');
    await report('ws_CO_1');
    assert.equal((await row(o.id)).status, 'paid');

    // Same again, but another buyer takes the name while the first payment is still in flight.
    await freshDb(); fakeMpesa();
    const x = await operatorWithSite('x@example.com', 'shopx'), y = await operatorWithSite('y@example.com', 'shopy');
    const ox = (await order(x)).body.order;
    await sql`UPDATE domain_orders SET expires_at = now() - interval '1 minute' WHERE id = ${ox.id}`;
    const oy = (await order(y)).body.order;                                    // expires x's order, y gets the name
    assert.equal((await row(ox.id)).status, 'expired');
    await report('ws_CO_1');                                                    // x paid late
    assert.equal((await row(ox.id)).status, 'refund_due');
    assert.equal((await row(oy.id)).status, 'awaiting_payment');
});

test('an operator can cancel a waiting order, but not someone else\'s', async () => {
    const a = await operatorWithSite('a@example.com', 'shopa'), b = await operatorWithSite('b@example.com', 'shopb');
    const { body: { order: o } } = await order(a);
    assert.equal((await call(domains, { method: 'POST', cookie: b.cookie, body: { action: 'cancel', id: o.id } })).body.cancelled, false);
    assert.equal((await call(domains, { method: 'POST', cookie: a.cookie, body: { action: 'cancel', id: o.id } })).body.cancelled, true);
    assert.equal((await row(o.id)).status, 'cancelled');
});

test('without the callback secret configured the callback refuses everything', async () => {
    delete process.env.MPESA_CALLBACK_SECRET;
    assert.equal((await call(payCallback, { method: 'POST', query: { k: '' }, body: cbBody('ws_CO_1') })).status, 503);
});
