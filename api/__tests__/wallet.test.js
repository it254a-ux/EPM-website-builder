// Wallet: paying for a domain from confirmed earnings. Safe spending, refunds back to the wallet, history, withdrawals.
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

const admin = require('../admin');
const commissions = require('../_lib/commissions');
const W = require('../_lib/wallet');
// Gives an operator `usd` of CONFIRMED earnings (a month Deriv has paid).
async function fund(opId, usd) {
    await sql`INSERT INTO commission_daily (app_id, day, owner_id, markup_usd, platform_share, owner_usd) VALUES ('APP1', '2026-08-15', ${opId}, ${usd * 2}, 50, ${usd})`;
    await sql`INSERT INTO commission_months (month) VALUES ('2026-08') ON CONFLICT DO NOTHING`;
}
const balance = async opId => (await commissions.balances(sql, opId)).available;
const debit = async () => (await sql`SELECT * FROM wallet_debits ORDER BY id DESC LIMIT 1`)[0];
let stk;
const wrapStk = () => {
    stk = 0; const orig = M.setTransport;
    M.setTransport(async url => {
        if (url.includes('/oauth/')) return { status: 200, body: { access_token: 'tok', expires_in: '3599' } };
        if (url.includes('processrequest')) { stk++; return { status: 200, body: { MerchantRequestID: 'mr', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0' } }; }
        return { status: 200, body: { ResultCode: '0', ResultDesc: 'ok' } };
    });
    return orig;
};

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, PLATFORM_ROOT_DOMAIN: 'free.test', KES_PER_USD: '130',
        MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'K', MPESA_CONSUMER_SECRET: 'S', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'P', MPESA_CALLBACK_SECRET: SECRET,
        DOMAINS_VERCEL_TOKEN: TOKEN, DOMAINS_VERCEL_PROJECT: 'trading-site' });
    fakes(); wrapStk();
});
test.afterEach(() => {
    M.setTransport(null); R.setTransport(null); VD.setTransport(null);
    for (const k of ['KES_PER_USD', 'MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'DOMAINS_VERCEL_TOKEN', 'DOMAINS_VERCEL_PROJECT']) delete process.env[k];
});

test('renewing from the wallet: balance drops by the price, Vercel renews, no M-Pesa prompt, no phone needed', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 100);
    const before = await balance(op.id);
    const placed = await post(op, { action: 'renew', pay: 'wallet' });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.order.status, 'completed');
    assert.equal(placed.body.order.pay_method, 'wallet');
    assert.match(placed.body.order.message, /Done/);
    assert.equal(stk, 0);
    assert.equal(renewCalls.length, 1);
    const d = await debit();
    assert.equal(d.status, 'spent');
    assert.equal(Number(d.amount_usd), 13.81);
    assert.equal(await balance(op.id), Math.floor((before - 13.81) * 100) / 100);
    assert.ok(new Date((await site()).domain_expires_at) > new Date(Date.now() + 300 * 86400000));
});

test('not enough in the wallet: nothing is taken, nothing is bought, the order is cancelled', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 5);
    const placed = await post(op, { action: 'renew', pay: 'wallet' });
    assert.equal(placed.status, 402);
    assert.match(placed.body.error, /not have enough/);
    assert.equal(renewCalls.length, 0);
    assert.equal(await balance(op.id), 5);
    assert.equal((await sql`SELECT count(*)::int AS n FROM wallet_debits`)[0].n, 0);
    assert.equal((await sql`SELECT status FROM domain_orders WHERE kind = 'renewal'`)[0].status, 'cancelled');
});

test('earnings Deriv has not paid yet cannot be spent', async () => {
    const { op } = await boughtSite(20);
    await sql`INSERT INTO commission_daily (app_id, day, owner_id, markup_usd, platform_share, owner_usd) VALUES ('APP1', '2026-09-15', ${op.id}, 400, 50, 200)`;   // month not confirmed
    assert.equal(await balance(op.id), 0);
    assert.equal((await post(op, { action: 'renew', pay: 'wallet' })).status, 402);
});

test('the registrar says no: the money goes straight back to the wallet and the order says so', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 100);
    renewReply = { status: 400, body: { error: { code: 'bad', message: 'Not allowed' } } };
    const placed = await post(op, { action: 'renew', pay: 'wallet' });
    assert.equal(placed.status, 201);
    assert.equal(placed.body.order.status, 'refunded');
    assert.match(placed.body.order.message, /back in your wallet/);
    assert.equal((await debit()).status, 'refunded');
    assert.equal(await balance(op.id), 100);
    const h = await W.history(sql, op.id);
    assert.ok(h.some(x => x.type === 'refund' && x.amount === 13.81));
});

test('the registrar is unsure: the money stays held (not spendable, not returned) until a person decides', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 100);
    renewReply = new Error('network died');
    const placed = await post(op, { action: 'renew', pay: 'wallet' });
    assert.equal(placed.body.order.status, 'check_needed');
    assert.equal((await debit()).status, 'held');
    assert.equal(await balance(op.id), Math.floor((100 - 13.81) * 100) / 100);
    // while it is held, a second wallet payment is refused
    assert.equal((await post(op, { action: 'renew', pay: 'wallet' })).status, 409);

    // the admin finds it was not renewed and refunds it: the money returns
    const ad = await login('admin', 'a@example.com');
    const id = (await sql`SELECT id FROM domain_orders WHERE status = 'check_needed'`)[0].id;
    const r = await call(admin, { method: 'POST', cookie: ad.cookie, body: { action: 'order_refunded', id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await debit()).status, 'refunded');
    assert.equal(await balance(op.id), 100);
});

test('the admin finds it WAS renewed: marking it complete turns the held money into spent', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 100);
    renewReply = new Error('network died');
    await post(op, { action: 'renew', pay: 'wallet' });
    const ad = await login('admin', 'a@example.com');
    const id = (await sql`SELECT id FROM domain_orders WHERE status = 'check_needed'`)[0].id;
    assert.equal((await call(admin, { method: 'POST', cookie: ad.cookie, body: { action: 'order_complete', id } })).status, 200);
    assert.equal((await debit()).status, 'spent');
});

test('two wallet payments at the same moment: only one goes through, the balance never goes below zero', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 14);                                  // enough for one renewal (13.81), not two
    const results = await Promise.all([post(op, { action: 'renew', pay: 'wallet' }), post(op, { action: 'renew', pay: 'wallet' })]);
    const ok = results.filter(r => r.status === 201);
    assert.equal(ok.length, 1, JSON.stringify(results.map(r => r.body)));
    assert.equal(renewCalls.length, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM wallet_debits`)[0].n, 1);
    assert.ok((await W.available(sql, op.id)).raw >= 0);
});

test('a withdrawal cannot use money already spent on a domain, and the wallet cannot spend money already requested', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 20);
    assert.equal((await post(op, { action: 'renew', pay: 'wallet' })).body.order.status, 'completed');   // 20 - 13.81 = 6.19 left
    assert.equal(await commissions.createWithdrawal(sql, op.id, { amount: 10, method: 'mpesa', network: null, destination: '254712345678' }), null);
    assert.ok(await commissions.createWithdrawal(sql, op.id, { amount: 6, method: 'mpesa', network: null, destination: '254712345678' }));
    assert.equal(await balance(op.id), 0.19);
    // and the other way round
    await freshDb(); fakes(); wrapStk();
    const b = await boughtSite(20); await fund(b.op.id, 20);
    assert.ok(await commissions.createWithdrawal(sql, b.op.id, { amount: 10, method: 'mpesa', network: null, destination: '254712345678' }));
    assert.equal((await post(b.op, { action: 'renew', pay: 'wallet' })).status, 402);
});

test('the history lists earnings, spending and withdrawals, and shows the amount spent', async () => {
    const { op } = await boughtSite(20);
    await fund(op.id, 100);
    await post(op, { action: 'renew', pay: 'wallet' });
    await commissions.createWithdrawal(sql, op.id, { amount: 10, method: 'usdt', network: 'TRC20', destination: 'T' + 'a'.repeat(33) });
    const view = await commissions.operatorView(sql, op.id);
    const types = view.wallet.map(x => x.type);
    for (const t of ['earnings', 'domain', 'withdrawal']) assert.ok(types.includes(t), t);
    assert.equal(view.summary.spent, 13.81);
    assert.equal(view.summary.available, Math.floor((100 - 13.81 - 10) * 100) / 100);
    assert.ok(!JSON.stringify(view).includes('cost'));
});

test('another operator\'s wallet is never touched', async () => {
    const a = await boughtSite(20); await fund(a.op.id, 100);
    const other = await login('operator', 'z@example.com');
    await call(mySite, { method: 'POST', cookie: other.cookie, body: { name: 'Z', subdomain: 'zed' } });
    assert.equal((await post(other, { action: 'renew', pay: 'wallet' })).status, 400);      // no bought domain
    assert.equal(await balance(a.op.id), 100);
});

test('buying a new domain from the wallet works with no M-Pesa setup: registered, site switched, debit spent', async () => {
    for (const k of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET']) delete process.env[k];
    const op = await login('operator', 'b@example.com');
    await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: 'Shop', subdomain: 'shopb' } });
    await fund(op.id, 100);
    const buys = [];
    R.setTransport(async (url, options) => {
        if (url.endsWith('/search')) return { status: 200, body: { results: JSON.parse(options.body).domains.map(d => ({ domain: d, available: d === 'mybrand.com', years: 1, price: 11.25, renewalPrice: 11.25, premium: false })) } };
        buys.push(url); return { status: 200, body: { orderId: 'ord_1', _links: {} } };
    });
    const r = await post(op, { action: 'order', pay: 'wallet', domain: 'mybrand.com', phone: '0712345678',
        contact: { first_name: 'A', last_name: 'B', address1: '1 Road', city: 'Nairobi', state: 'Nairobi', zip: '00100', country: 'KE' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.status, 'completed');
    assert.equal(buys.length, 1);
    assert.equal(stk, 0);
    assert.equal((await debit()).status, 'spent');
    assert.equal((await sql`SELECT domain, plan FROM sites`)[0].domain, 'mybrand.com');
    // a price shown with no wallet money is refused cleanly
    const poor = await login('operator', 'p@example.com');
    const mk = await call(mySite, { method: 'POST', cookie: poor.cookie, body: { name: 'Poor Shop', subdomain: 'poorshop' } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const r2 = await post(poor, { action: 'order', pay: 'wallet', domain: 'mybrand.com', phone: '0712345678', contact: { first_name: 'A', last_name: 'B', address1: '1', city: 'N', state: 'N', zip: '1', country: 'KE' } });
    assert.ok([402, 409].includes(r2.status), r2.status + ' ' + JSON.stringify(r2.body));
});
