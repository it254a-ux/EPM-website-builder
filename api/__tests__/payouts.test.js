// Paying operators through the system (M-Pesa business payment) and the safety rules around it.
// Real handlers + real SQL (in-memory Postgres). Safaricom is replaced by a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const admin = require('../admin');
const commissions = require('../commissions');
const payB2c = require('../pay-callback');
const A = require('../_lib/auth');
const M = require('../_lib/mpesa');
const PO = require('../_lib/payouts');

const HOST = 'builder.test', SECRET = 'cb-secret';

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

let b2cCalls, b2cReply;
function fakeMpesa() {
    b2cCalls = []; b2cReply = { status: 200, body: { ConversationID: 'AG_1', OriginatorConversationID: 'OC_1', ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } };
    M.setTransport(async (url, options) => {
        if (url.includes('/oauth/')) return { status: 200, body: { access_token: 'tok', expires_in: '3599' } };
        if (url.includes('/b2c/')) { b2cCalls.push({ url, options, body: JSON.parse(options.body) }); if (b2cReply instanceof Error) throw b2cReply; return b2cReply; }
        throw new Error('unexpected ' + url);
    });
}
const resultBody = ({ code = 0, amount = 6460, receipt = 'SJK81PQ2LM', desc = 'The service request is processed successfully.' } = {}) => ({ Result: { ResultType: 0, ResultCode: code, ResultDesc: desc, OriginatorConversationID: 'OC_1', ConversationID: 'AG_1', TransactionID: receipt,
    ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: amount }, { Key: 'TransactionReceipt', Value: receipt }] } } });
const callback = (id, body, { k = SECRET, t = 'result' } = {}) => call(payB2c, { method: 'POST', query: { k, p: String(id), t }, body });

async function request(over = {}) {
    const op = await login('operator', over.email || 'o@example.com');
    const r = (await sql`INSERT INTO payout_requests (owner_id, amount_usd, method, network, destination) VALUES (${op.id}, ${over.usd || 50}, ${over.method || 'mpesa'}, ${over.method === 'usdt' ? 'TRC20' : null}, ${over.method === 'usdt' ? 'TXabc' : '254712345678'}) RETURNING id`)[0];
    return { op, id: r.id };
}
const row = async id => (await sql`SELECT * FROM payout_requests WHERE id = ${id}`)[0];

test.beforeEach(async () => {
    await freshDb();
    Object.assign(process.env, { PLATFORM_HOSTS: HOST, KES_PER_USD: '129.2',
        MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'K', MPESA_CONSUMER_SECRET: 'S', MPESA_CALLBACK_SECRET: SECRET,
        MPESA_B2C_SHORTCODE: '600984', MPESA_B2C_INITIATOR: 'testapi', MPESA_B2C_CREDENTIAL: 'READY-MADE-CREDENTIAL' });
    delete process.env.MPESA_B2C_INITIATOR_PASSWORD; delete process.env.MPESA_B2C_CERT;
    fakeMpesa();
});
test.afterEach(() => {
    M.setTransport(null);
    for (const k of ['KES_PER_USD', 'MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_CALLBACK_SECRET', 'MPESA_B2C_SHORTCODE', 'MPESA_B2C_INITIATOR', 'MPESA_B2C_CREDENTIAL', 'MPESA_B2C_INITIATOR_PASSWORD', 'MPESA_B2C_CERT']) delete process.env[k];
});

test('the security credential: ready-made is used as is; password plus certificate is encrypted so only Safaricom can read it', () => {
    assert.equal(M.securityCredential(), 'READY-MADE-CREDENTIAL');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    delete process.env.MPESA_B2C_CREDENTIAL;
    process.env.MPESA_B2C_INITIATOR_PASSWORD = 'Sup3rSecret!';
    process.env.MPESA_B2C_CERT = publicKey.export({ type: 'spki', format: 'pem' });
    const cred = M.securityCredential();
    assert.ok(!cred.includes('Sup3rSecret'));
    assert.equal(crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(cred, 'base64')).toString(), 'Sup3rSecret!');
    process.env.MPESA_B2C_CERT = process.env.MPESA_B2C_CERT.replace(/\n/g, '\\n');          // Vercel may store line breaks as \n
    assert.ok(M.securityCredential().length > 100);
});

test('settings: what is missing is named', () => {
    assert.equal(M.b2cConfigured(), true);
    delete process.env.MPESA_B2C_CREDENTIAL; delete process.env.MPESA_B2C_INITIATOR;
    assert.equal(M.b2cConfigured(), false);
    assert.deepEqual(M.b2cMissing().map(x => x.split(' ')[0]), ['MPESA_B2C_INITIATOR', 'MPESA_B2C_CREDENTIAL']);
});

test('Pay with M-Pesa sends the right request and waits for Safaricom before ticking paid', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request({ usd: 50 });
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal(r.status, 200);
    assert.match(r.body.notice, /Sent KES 6460 to 254712345678/);                 // 50 x 129.2 = 6460
    const sent = b2cCalls[0];
    assert.equal(sent.url, 'https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest');
    assert.equal(sent.body.InitiatorName, 'testapi');
    assert.equal(sent.body.SecurityCredential, 'READY-MADE-CREDENTIAL');
    assert.equal(sent.body.CommandID, 'BusinessPayment');
    assert.equal(sent.body.Amount, 6460);
    assert.equal(sent.body.PartyA, '600984'); assert.equal(sent.body.PartyB, '254712345678');
    assert.equal(sent.body.ResultURL, `https://${HOST}/api/pay-callback?k=${SECRET}&p=${id}&t=result`);
    assert.equal(sent.body.QueueTimeOutURL, `https://${HOST}/api/pay-callback?k=${SECRET}&p=${id}&t=timeout`);
    assert.ok(!JSON.stringify(r.body).includes('READY-MADE'));

    let o = await row(id);
    assert.equal(o.status, 'requested');                                           // not paid yet: Safaricom has not confirmed
    assert.equal(o.send_state, 'sending');
    assert.equal(o.sent_kes, 6460);

    assert.equal((await callback(id, resultBody())).status, 200);
    o = await row(id);
    assert.equal(o.status, 'paid');
    assert.equal(o.reference, 'SJK81PQ2LM');
    assert.equal(o.send_state, null);
    assert.ok(o.decided_at);
});

test('the same result arriving twice changes nothing; wrong secret, wrong number or junk are ignored', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal((await callback(id, resultBody(), { k: 'wrong' })).status, 401);
    assert.equal((await callback(9999, resultBody())).status, 200);
    assert.equal((await callback(id, { nope: 1 })).status, 200);
    assert.equal((await row(id)).status, 'requested');
    await callback(id, resultBody());
    const first = await row(id);
    await callback(id, resultBody());
    const again = await row(id);
    assert.equal(again.status, 'paid');
    assert.equal(again.decided_at.toISOString(), first.decided_at.toISOString());
    assert.equal((await call(payB2c, { method: 'GET', query: { k: SECRET, p: '1' } })).status, 405);
});

test('if M-Pesa cannot send, the request goes back to pending with the reason, and can be tried again', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    await callback(id, resultBody({ code: 2001, desc: 'The initiator information is invalid.' }));
    let o = await row(id);
    assert.equal(o.status, 'requested');
    assert.equal(o.send_state, null);
    assert.match(o.send_error, /initiator information is invalid/);

    const retry = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal(retry.status, 200);
    await callback(id, resultBody());
    assert.equal((await row(id)).status, 'paid');
    assert.equal(b2cCalls.length, 2);

    // refused before sending: also pending with the reason
    await freshDb(); fakeMpesa();
    const adm2 = await login('admin', 'a2@example.com');
    const second = await request({ email: 'o2@example.com' });
    b2cReply = { status: 400, body: { requestId: 'x', errorCode: '500.002.1001', errorMessage: 'Invalid Initiator' } };
    const bad = await call(admin, { method: 'POST', cookie: adm2.cookie, body: { action: 'payout_send', id: second.id } });
    assert.equal(bad.status, 502);
    o = await row(second.id);
    assert.equal(o.send_state, null);
    assert.match(o.send_error, /Invalid Initiator/);
});

test('no answer from Safaricom: it stays "sending", is never retried by itself, and can be released only after 10 minutes', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    b2cReply = new Error('socket hang up');
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal(r.status, 200);
    assert.match(r.body.warning, /may or may not have been sent/);
    assert.equal((await row(id)).send_state, 'sending');
    const again = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal(again.status, 409);
    assert.equal(b2cCalls.length, 1);

    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_release', id } })).status, 409);     // too soon
    await sql`UPDATE payout_requests SET sent_at = now() - interval '11 minutes' WHERE id = ${id}`;
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_release', id } })).status, 200);
    const o = await row(id);
    assert.equal(o.send_state, null); assert.equal(o.status, 'requested');
});

test('two clicks at once send the money only once', async () => {
    const { id } = await request();
    const results = await Promise.all([PO.sendMpesa(sql, id, HOST), PO.sendMpesa(sql, id, HOST), PO.sendMpesa(sql, id, HOST)]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(b2cCalls.length, 1);
});

test('only waiting M-Pesa requests can be sent; USDT, paid and rejected ones cannot', async () => {
    const adm = await login('admin', 'a@example.com');
    const usdt = await request({ method: 'usdt', email: 'u@example.com' });
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id: usdt.id } })).status, 409);
    const paid = await request({ email: 'p@example.com' });
    await sql`UPDATE payout_requests SET status = 'paid' WHERE id = ${paid.id}`;
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id: paid.id } })).status, 409);
    const op = await login('operator', 'x@example.com');
    assert.equal((await call(admin, { method: 'POST', cookie: op.cookie, body: { action: 'payout_send', id: usdt.id } })).status, 403);
    assert.equal(b2cCalls.length, 0);
});

test('while money is being sent, nobody can mark it paid, reject it, or cancel it', async () => {
    const adm = await login('admin', 'a@example.com');
    const { op, id } = await request();
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    const post = body => call(admin, { method: 'POST', cookie: adm.cookie, body });
    assert.equal((await post({ action: 'payout_paid', id, reference: 'MANUAL123' })).status, 409);
    assert.equal((await post({ action: 'payout_reject', id, note: 'no' })).status, 409);
    const cancel = await call(commissions, { method: 'POST', cookie: op.cookie, body: { action: 'cancel', id } });
    assert.ok(cancel.status === 409 || cancel.body.cancelled === false || cancel.body.error, 'cancel must not go through: ' + JSON.stringify(cancel.body));
    const o = await row(id);
    assert.equal(o.status, 'requested'); assert.equal(o.send_state, 'sending');
});

test('manual paying still works when nothing is being sent, and clears an old error', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    await callback(id, resultBody({ code: 2001, desc: 'The initiator information is invalid.' }));
    assert.ok((await row(id)).send_error);
    const r = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_paid', id, reference: 'SENT-BY-HAND-1' } });
    assert.equal(r.status, 200);
    const o = await row(id);
    assert.equal(o.status, 'paid'); assert.equal(o.reference, 'SENT-BY-HAND-1'); assert.equal(o.send_error, null);
});

test('if M-Pesa did send after you released and paid by hand, the double payment is flagged, not hidden', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    b2cReply = new Error('timeout');
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    await sql`UPDATE payout_requests SET sent_at = now() - interval '20 minutes' WHERE id = ${id}`;
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_release', id } });
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_paid', id, reference: 'BYHAND9' } });
    await callback(id, resultBody());                                              // the first send did go through after all
    const o = await row(id);
    assert.equal(o.status, 'paid'); assert.equal(o.reference, 'BYHAND9');
    assert.match(o.send_error, /^DUPLICATE/);
});

test('a result for a different amount is not trusted', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request({ usd: 50 });
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    await callback(id, resultBody({ amount: 100 }));
    const o = await row(id);
    assert.equal(o.status, 'requested'); assert.equal(o.send_state, 'sending');
    assert.match(o.send_error, /KES 100 was sent but we asked for KES 6460/);
});

test('not set up, no rate, or tiny amounts: clear refusals and nothing sent', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request({ usd: 50 });
    delete process.env.MPESA_B2C_INITIATOR;
    const off = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    assert.equal(off.status, 409);
    assert.match(off.body.error, /MPESA_B2C_INITIATOR/);
    process.env.MPESA_B2C_INITIATOR = 'testapi';
    delete process.env.KES_PER_USD;
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } })).status, 503);
    process.env.KES_PER_USD = '129.2';
    const tiny = await request({ usd: 0.05, email: 't@example.com' });
    const t = await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id: tiny.id } });
    assert.equal(t.status, 400);
    assert.equal((await row(tiny.id)).send_state, null);
    assert.equal(b2cCalls.length, 0);
    assert.equal((await row(id)).send_state, null);
});

test('the admin view shows readiness and the new fields; money still counts as taken from the balance while sending', async () => {
    const adm = await login('admin', 'a@example.com');
    const { id } = await request();
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_send', id } });
    const view = (await call(admin, { query: { resource: 'commissions' }, cookie: adm.cookie })).body;
    const c = view.commissions || view;
    assert.equal(c.b2c_ready, true);
    const r = c.requests.find(x => x.id === id);
    assert.equal(r.send_state, 'sending'); assert.equal(r.sent_kes, 6460);
    assert.equal(r.status, 'requested');                                           // still 'requested', so existing balance rules hold
});
