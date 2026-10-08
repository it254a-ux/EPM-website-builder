// Commissions: Deriv markup reports -> ledger -> balances -> withdrawals. Real handlers + real SQL (in-memory Postgres).
// Deriv is replaced by a fake fetch, and the real fetch is also run against a local HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const mySite = require('../my-site');
const admin = require('../admin');
const authApi = require('../auth');
const commissionsApi = require('../commissions');
const cron = require('../cron-commissions');
const A = require('../_lib/auth');
const C = require('../_lib/commissions');

const HOST = 'builder.test';
const TOKEN = 'SECRET-STATS-TOKEN-456';
const WALLET = `T${'Q'.repeat(33)}`;

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
// An operator with a free site that has this App ID.
async function operatorWithApp(email, subdomain, appId, extra = {}) {
    const op = await login('operator', email);
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: subdomain, subdomain, ...extra } });
    assert.equal(r.status, 201);
    await sql`UPDATE sites SET app_id = ${appId} WHERE owner_id = ${op.id}`;
    return op;
}

// A fake Deriv markup report. rowsByDay: { 'YYYY-MM-DD': [{ app_id, app_markup_usd, ... }] }
function fakeStats(rowsByDay, { status = 200, errorBody } = {}) {
    const seen = [];
    C.setFetch(async (url, opts) => {
        seen.push({ url: String(url), headers: opts.headers });
        const day = new URL(url).searchParams.get('date_from');
        if (status !== 200) return { ok: false, status, json: async () => errorBody || {} };
        return { ok: true, status: 200, json: async () => ({ data: { breakdown: rowsByDay[day] || [] }, meta: {} }) };
    });
    return seen;
}
const row = (app_id, markup, extra = {}) => ({ app_id, app_markup_usd: markup, volume_usd: 1000, payout_usd: 1900, contract_count: 40, client_count: 5, ...extra });

// A day in the last full month (so it can be confirmed), computed from today.
const lastMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const DAY1 = `${lastMonth}-10`, DAY2 = `${lastMonth}-11`;

test.beforeEach(async () => {
    await freshDb();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    process.env.DERIV_STATS_TOKEN = TOKEN;
    delete process.env.DERIV_STATS_APP_ID; delete process.env.WITHDRAWAL_MIN_USD; delete process.env.DERIV_API_BASE;
});
test.afterEach(() => { C.setFetch(null); delete process.env.DERIV_STATS_TOKEN; delete process.env.CRON_SECRET; delete process.env.DERIV_API_BASE; delete process.env.DERIV_STATS_APP_ID; });

// ---------- syncing ----------
test('each app\'s markup becomes the operator\'s part, using the share of that plan', async () => {
    const free = await operatorWithApp('free@example.com', 'freesite', 'APPFREE1');
    const cust = await login('operator', 'cust@example.com');
    await call(mySite, { method: 'POST', cookie: cust.cookie, body: { name: 'Custom', custom_domain: 'trade.custom.com', whatsapp: '254700000000' } });
    await sql`UPDATE sites SET app_id = 'APPCUST1' WHERE owner_id = ${cust.id}`;
    const seen = fakeStats({ [DAY1]: [row('APPFREE1', 10), row('APPCUST1', 20), row('SOMEONEELSE', 99)] });

    const r = await C.syncDay(sql, DAY1);
    assert.deepEqual([r.apps, r.matched, r.unmatched], [3, 2, 1]);
    const get = async id => Number((await sql`SELECT owner_usd FROM commission_daily WHERE owner_id = ${id}`)[0].owner_usd);
    assert.equal(await get(free.id), 7.5, 'free address: platform keeps 25%, operator gets 75% of 10');
    assert.equal(await get(cust.id), 17, 'own domain: platform keeps 15%, operator gets 85% of 20');
    assert.equal((await sql`SELECT count(*)::int AS n FROM commission_daily`)[0].n, 2, 'an app that is not an operator\'s is not stored');
    assert.ok(seen[0].url.includes(`date_from=${DAY1}&date_to=${DAY1}`), 'asks for exactly one UTC day');
    assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(seen[0].headers['Deriv-App-ID'], undefined, 'no App ID header unless configured');
});

test('the App ID header is sent when configured', async () => {
    process.env.DERIV_STATS_APP_ID = 'MAINAPP123';
    const seen = fakeStats({});
    await C.syncDay(sql, DAY1);
    assert.equal(seen[0].headers['Deriv-App-ID'], 'MAINAPP123');
});

test('the share in force on that day is used, not today\'s', async () => {
    const op = await operatorWithApp('op@example.com', 'julias', 'APPJ1');
    const siteId = (await sql`SELECT id FROM sites WHERE owner_id = ${op.id}`)[0].id;
    await sql`DELETE FROM site_rate_history WHERE site_id = ${siteId}`;
    await sql`INSERT INTO site_rate_history (site_id, plan, platform_share, effective_from) VALUES (${siteId}, 'free', 25, '2000-01-01'), (${siteId}, 'custom', 15, ${`${lastMonth}-20`})`;
    fakeStats({ [DAY1]: [row('APPJ1', 100)], [`${lastMonth}-25`]: [row('APPJ1', 100)] });
    await C.syncDay(sql, DAY1);
    await C.syncDay(sql, `${lastMonth}-25`);
    const rows = await sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, platform_share, owner_usd FROM commission_daily ORDER BY day`;
    assert.deepEqual(rows.map(r => [Number(r.platform_share), Number(r.owner_usd)]), [[25, 75], [15, 85]]);
});

test('syncing the same day again replaces it instead of adding to it', async () => {
    await operatorWithApp('op@example.com', 'julias', 'APPJ1');
    fakeStats({ [DAY1]: [row('APPJ1', 10)] });
    await C.syncDay(sql, DAY1); await C.syncDay(sql, DAY1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM commission_daily`)[0].n, 1);
    fakeStats({ [DAY1]: [row('APPJ1', 20)] });
    await C.syncDay(sql, DAY1);
    assert.equal(Number((await sql`SELECT owner_usd FROM commission_daily`)[0].owner_usd), 15);
});

test('a confirmed month is frozen: a later sync cannot change it', async () => {
    await operatorWithApp('op@example.com', 'julias', 'APPJ1');
    const adm = await login('admin', 'admin@example.com');
    fakeStats({ [DAY1]: [row('APPJ1', 10)] });
    await C.syncDay(sql, DAY1);
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'confirm_month', month: lastMonth } })).status, 200);
    fakeStats({ [DAY1]: [row('APPJ1', 1)], [DAY2]: [row('APPJ1', 50)] });
    const r1 = await C.syncDay(sql, DAY1), r2 = await C.syncDay(sql, DAY2);
    assert.equal(r1.locked && r2.locked, true);
    const rows = await sql`SELECT owner_usd FROM commission_daily`;
    assert.deepEqual(rows.map(r => Number(r.owner_usd)), [7.5]);
});

test('a failed Deriv call says what happened and never contains the token', async () => {
    fakeStats({}, { status: 401, errorBody: { errors: [{ status: 401, code: 'Unauthorized', message: 'Invalid or missing authentication credentials' }] } });
    await assert.rejects(() => C.syncDay(sql, DAY1), e => { assert.match(e.message, /401.*Invalid or missing/); assert.equal(e.message.includes(TOKEN), false); return true; });
    C.setFetch(async () => { throw new Error(`boom ${TOKEN}`); });
    await assert.rejects(() => C.syncDay(sql, DAY1), e => { assert.equal(e.message, 'Could not reach Deriv.'); return true; });
    C.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    await assert.rejects(() => C.syncDay(sql, DAY1), /did not expect/);
    delete process.env.DERIV_STATS_TOKEN;
    await assert.rejects(() => C.syncDay(sql, DAY1), /DERIV_STATS_TOKEN is not set/);
});

test('rows Deriv sends that are malformed are ignored, not stored', async () => {
    await operatorWithApp('op@example.com', 'julias', 'APPJ1');
    fakeStats({ [DAY1]: [row('APPJ1', 10), row('BAD APP!', 5), row('APPJ1', -3), row('APPJ1', 'abc'), null] });
    const r = await C.syncDay(sql, DAY1);
    assert.equal(r.apps, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM commission_daily`)[0].n, 1);
});

test('the real fetch sends the right request to a server (path, dates, headers)', async () => {
    await operatorWithApp('op@example.com', 'julias', 'APPJ1');
    let seen;
    const server = http.createServer((req, res) => {
        seen = { url: req.url, auth: req.headers.authorization, appId: req.headers['deriv-app-id'] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { breakdown: [row('APPJ1', 8)] }, meta: {} }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        process.env.DERIV_API_BASE = `http://127.0.0.1:${server.address().port}`;
        process.env.DERIV_STATS_APP_ID = 'MAINAPP123';
        await C.syncDay(sql, DAY1);
        assert.equal(seen.url, `/applications/v1/markup-statistics?date_from=${DAY1}&date_to=${DAY1}`);
        assert.equal(seen.auth, `Bearer ${TOKEN}`);
        assert.equal(seen.appId, 'MAINAPP123');
        assert.equal(Number((await sql`SELECT owner_usd FROM commission_daily`)[0].owner_usd), 6);
    } finally { server.close(); }
});

// ---------- balances ----------
async function earn(opEmail, sub, app, markupByDay) {
    const op = await operatorWithApp(opEmail, sub, app);
    fakeStats(Object.fromEntries(Object.entries(markupByDay).map(([d, m]) => [d, [row(app, m)]])));
    for (const d of Object.keys(markupByDay)) await C.syncDay(sql, d);
    return op;
}
const confirm = (adm, month = lastMonth) => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'confirm_month', month } });

test('earnings wait for Deriv\'s payment, then become available when the month is confirmed', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40, [DAY2]: 40 }); // operator gets 30 + 30
    const adm = await login('admin', 'admin@example.com');
    let v = (await call(commissionsApi, { cookie: op.cookie })).body;
    assert.deepEqual([v.summary.available, v.summary.pending], [0, 60]);
    assert.equal((await confirm(adm)).status, 200);
    v = (await call(commissionsApi, { cookie: op.cookie })).body;
    assert.deepEqual([v.summary.available, v.summary.pending], [60, 0]);
    assert.deepEqual(v.months, [{ month: lastMonth, amount: 60, confirmed: true }]);
    assert.deepEqual(v.days.map(d => d.day), [DAY2, DAY1]);
});

test('a balance is rounded down to the cent, never up', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 14.666 }); // 14.666 x 75% = 10.9995
    await confirm(await login('admin', 'admin@example.com'));
    assert.equal((await C.balances(sql, op.id)).available, 10.99);
});

test('only the operator\'s own earnings are shown, and never markup, volume, contracts, clients or shares', async () => {
    const a = await earn('a@example.com', 'alpha', 'APPA', { [DAY1]: 40 });
    await earn('b@example.com', 'beta', 'APPB', { [DAY1]: 400 });
    await confirm(await login('admin', 'admin@example.com'));
    await call(commissionsApi, { method: 'POST', cookie: a.cookie, body: { action: 'withdraw', amount: '10', method: 'mpesa', destination: '0712345678' } });
    const v = (await call(commissionsApi, { cookie: a.cookie })).body;
    const text = JSON.stringify(v);
    assert.deepEqual(Object.keys(v).sort(), ['days', 'min_withdrawal', 'months', 'requests', 'summary']);
    assert.equal(/markup|volume|contract|client|share|app_id|platform/i.test(Object.keys(JSON.parse(text)).concat(Object.keys(v.summary), Object.keys(v.days[0]), Object.keys(v.months[0]), Object.keys(v.requests[0])).join(' ')), false);
    assert.equal(v.summary.available + v.summary.requested, 30);
    assert.equal(text.includes('0712345678') || text.includes('254712345678'), false, 'the full phone number is masked');
});

// ---------- withdrawals ----------
async function stocked(email = 'op@example.com') {
    const op = await earn(email, `s${email.split('@')[0]}`, `APP${email.split('@')[0].toUpperCase()}`, { [DAY1]: 40, [DAY2]: 40 }); // 60 earned
    const adm = await login('admin', 'admin@example.com').catch(async () => ({ id: 0, cookie: '' }));
    return { op, adm };
}
const withdraw = (op, body) => call(commissionsApi, { method: 'POST', cookie: op.cookie, body: { action: 'withdraw', ...body } });

test('withdrawal checks: amount, minimum, method, phone, wallet and network', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40, [DAY2]: 40 });
    await confirm(await login('admin', 'admin@example.com'));
    const bad = async (b, field) => { const r = await withdraw(op, b); assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(r.body.fields[field], `${field}: ${JSON.stringify(b)}`); };
    await bad({ amount: 'abc', method: 'mpesa', destination: '0712345678' }, 'amount');
    await bad({ amount: '-5', method: 'mpesa', destination: '0712345678' }, 'amount');
    await bad({ amount: '25.999', method: 'mpesa', destination: '0712345678' }, 'amount');
    await bad({ amount: '9.99', method: 'mpesa', destination: '0712345678' }, 'amount');
    await bad({ amount: '25', method: 'paypal', destination: 'x' }, 'method');
    await bad({ amount: '25', method: 'mpesa', destination: '12345' }, 'destination');
    await bad({ amount: '25', method: 'mpesa', destination: '0612345678' }, 'destination');
    await bad({ amount: '25', method: 'usdt', network: 'SOLANA', destination: WALLET }, 'network');
    await bad({ amount: '25', method: 'usdt', network: 'TRC20', destination: '0x' + 'a'.repeat(40) }, 'destination');
    await bad({ amount: '25', method: 'usdt', network: 'ERC20', destination: WALLET }, 'destination');
    assert.equal((await sql`SELECT count(*)::int AS n FROM payout_requests`)[0].n, 0);
    assert.equal(C.normalizePhone('+254 712-345-678'), '254712345678');
    assert.equal(C.normalizePhone('0112345678'), '254112345678');
    assert.equal(C.normalizePhone('712345678'), '254712345678');
});

test('a withdrawal cannot exceed the available balance, and an open request counts against it', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40, [DAY2]: 40 }); // 60
    const adm = await login('admin', 'admin@example.com');
    const tooEarly = await withdraw(op, { amount: '10', method: 'mpesa', destination: '0712345678' });
    assert.equal(tooEarly.status, 400, 'nothing is withdrawable before the month is confirmed');
    assert.match(tooEarly.body.error, /up to \$0\.00/);
    await confirm(adm);
    const over = await withdraw(op, { amount: '60.01', method: 'mpesa', destination: '0712345678' });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /up to \$60\.00/);
    const ok = await withdraw(op, { amount: '45.50', method: 'mpesa', destination: '+254 712 345 678' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.summary.available, 14.5);
    assert.equal(ok.body.requests[0].destination.includes('254712345678'), false);
    assert.equal((await sql`SELECT destination FROM payout_requests`)[0].destination, '254712345678');
    const second = await withdraw(op, { amount: '10', method: 'mpesa', destination: '0712345678' });
    assert.equal(second.status, 409, 'one open request at a time');
});

test('two requests at the same moment create only one', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40, [DAY2]: 40 });
    await confirm(await login('admin', 'admin@example.com'));
    const [a, b] = await Promise.all([
        withdraw(op, { amount: '30', method: 'mpesa', destination: '0712345678' }),
        withdraw(op, { amount: '30', method: 'mpesa', destination: '0712345678' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal((await sql`SELECT count(*)::int AS n FROM payout_requests`)[0].n, 1);
});

test('cancelling frees the money; paying uses it up; rejecting gives it back with the reason', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40, [DAY2]: 40 }); // 60
    const adm = await login('admin', 'admin@example.com');
    await confirm(adm);
    const admin_ = body => call(admin, { method: 'POST', cookie: adm.cookie, body });

    let r = await withdraw(op, { amount: '20', method: 'usdt', network: 'TRC20', destination: WALLET });
    assert.equal(r.status, 201);
    const id = r.body.requests[0].id;
    r = await call(commissionsApi, { method: 'POST', cookie: op.cookie, body: { action: 'cancel', id } });
    assert.equal(r.body.summary.available, 60);
    assert.equal(r.body.requests[0].status, 'cancelled');

    r = await withdraw(op, { amount: '25', method: 'usdt', network: 'ERC20', destination: `0x${'b'.repeat(40)}` });
    const id2 = r.body.requests[0].id;
    assert.equal((await admin_({ action: 'payout_paid', id: id2, reference: '' })).status, 400, 'a reference is required');
    assert.equal((await admin_({ action: 'payout_paid', id: id2, reference: '<script>' })).status, 400);
    assert.equal((await admin_({ action: 'payout_paid', id: id2, reference: '0xabc123txhash' })).status, 200);
    r = (await call(commissionsApi, { cookie: op.cookie })).body;
    assert.deepEqual([r.summary.available, r.summary.paid, r.requests[0].status, r.requests[0].reference], [35, 25, 'paid', '0xabc123txhash']);
    assert.equal((await admin_({ action: 'payout_paid', id: id2, reference: 'AGAIN123' })).status, 404, 'a request is paid only once');

    r = await withdraw(op, { amount: '10', method: 'mpesa', destination: '0712345678' });
    const id3 = r.body.requests[0].id;
    assert.equal((await admin_({ action: 'payout_reject', id: id3, note: 'Number does not match your account name' })).status, 200);
    r = (await call(commissionsApi, { cookie: op.cookie })).body;
    assert.deepEqual([r.summary.available, r.requests[0].status, r.requests[0].note], [35, 'rejected', 'Number does not match your account name']);
});

test('an operator cannot cancel someone else\'s request, and operators cannot use the admin actions', async () => {
    const a = await earn('a@example.com', 'alpha', 'APPA', { [DAY1]: 40 });
    const b = await login('operator', 'b@example.com');
    const adm = await login('admin', 'admin@example.com');
    await confirm(adm);
    const id = (await withdraw(a, { amount: '10', method: 'mpesa', destination: '0712345678' })).body.requests[0].id;
    assert.equal((await call(commissionsApi, { method: 'POST', cookie: b.cookie, body: { action: 'cancel', id } })).status, 404);
    for (const action of ['payout_paid', 'payout_reject', 'confirm_month', 'commission_sync']) {
        assert.equal((await call(admin, { method: 'POST', cookie: b.cookie, body: { action, id, reference: 'ABC123', month: lastMonth, from: DAY1 } })).status, 403, action);
    }
    assert.equal((await call(commissionsApi, { cookie: '' })).status, 401);
    assert.equal((await call(commissionsApi, { cookie: adm.cookie })).status, 403, 'admins use the admin panel');
    assert.equal((await sql`SELECT status FROM payout_requests`)[0].status, 'requested');
});

// ---------- admin ----------
test('months can only be confirmed once they have ended, and only once', async () => {
    const adm = await login('admin', 'admin@example.com');
    const post = body => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'confirm_month', ...body } });
    assert.equal((await post({ month: C.todayUtc().slice(0, 7) })).status, 400, 'the current month is still running');
    assert.equal((await post({ month: '2999-01' })).status, 400);
    assert.equal((await post({ month: 'nope' })).status, 400);
    assert.equal((await post({ month: lastMonth })).status, 200);
    assert.equal((await post({ month: lastMonth })).status, 409);
});

test('the admin sees the full picture: markup, shares, days synced and each request with its full destination', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40 });
    const adm = await login('admin', 'admin@example.com');
    await confirm(adm);
    await withdraw(op, { amount: '10', method: 'mpesa', destination: '0712345678' });
    const v = (await call(admin, { cookie: adm.cookie, query: { resource: 'commissions' } })).body;
    assert.equal(v.configured, true);
    assert.deepEqual(v.months[0], { month: lastMonth, days_synced: 1, days_in_month: C.daysInMonth(lastMonth), markup_usd: 40, owner_usd: 30, platform_usd: 10, confirmed: true });
    assert.equal(v.requests[0].destination, '254712345678');
    assert.equal(v.requests[0].owner_email, 'op@example.com');
    assert.equal(JSON.stringify(v).includes(TOKEN), false);
});

test('admin sync: checks the dates, needs the token, and reports where it stopped', async () => {
    const adm = await login('admin', 'admin@example.com');
    const sync = body => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'commission_sync', ...body } });
    fakeStats({});
    assert.equal((await sync({ from: 'x', to: 'y' })).status, 400);
    assert.equal((await sync({ from: DAY2, to: DAY1 })).status, 400, 'end before start');
    assert.equal((await sync({ from: DAY1, to: C.addDays(C.todayUtc(), 1) })).status, 400, 'no future days');
    assert.equal((await sync({ from: C.addDays(DAY1, -20), to: DAY1 })).status, 400, 'at most 10 days');
    const ok = await sync({ from: DAY1, to: DAY2 });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.results.map(r => r.day), [DAY1, DAY2]);
    fakeStats({}, { status: 403, errorBody: { errors: [{ message: 'You do not have permission to access this resource' }] } });
    const failed = await sync({ from: DAY1, to: DAY2 });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, new RegExp(`Stopped at ${DAY1}: Deriv said 403`));
    delete process.env.DERIV_STATS_TOKEN;
    assert.equal((await sync({ from: DAY1, to: DAY1 })).status, 409);
});

// ---------- account deletion ----------
test('an account cannot be deleted while it is owed money or has a request waiting', async () => {
    const op = await earn('op@example.com', 'julias', 'APPJ1', { [DAY1]: 40 });
    const adm = await login('admin', 'admin@example.com');
    const selfDelete = () => call(authApi, { method: 'POST', query: { action: 'delete_account' }, cookie: op.cookie, body: { confirm: 'DELETE' } });
    const adminDelete = () => call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'delete_owner', owner_id: op.id } });
    assert.equal((await selfDelete()).status, 409, 'earnings still waiting for Deriv');
    assert.equal((await adminDelete()).status, 409);
    await confirm(adm);
    assert.match((await selfDelete()).body.error, /waiting to be paid out/);
    const id = (await withdraw(op, { amount: '30', method: 'mpesa', destination: '0712345678' })).body.requests[0].id;
    assert.match((await selfDelete()).body.error, /withdrawal request is still waiting/);
    await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'payout_paid', id, reference: 'QWE123RTY' } });
    assert.equal((await selfDelete()).status, 200, 'everything paid out: the account can go');
    assert.equal((await sql`SELECT count(*)::int AS n FROM payout_requests`)[0].n, 0);
});

test('an account with no earnings can still be deleted by the admin', async () => {
    const op = await login('operator', 'new@example.com');
    const adm = await login('admin', 'admin@example.com');
    assert.equal((await call(admin, { method: 'POST', cookie: adm.cookie, body: { action: 'delete_owner', owner_id: op.id } })).status, 200);
});

// ---------- the daily job ----------
test('the daily job: refuses without the secret, skips without a token, otherwise syncs three days', async () => {
    const run = secret => call(cron, { headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` } });
    assert.equal((await run('anything')).status, 503, 'no CRON_SECRET set: refuses');
    process.env.CRON_SECRET = 'cron-secret-xyz';
    assert.equal((await run()).status, 401);
    assert.equal((await run('wrong-secret')).status, 401);
    assert.equal((await run('cron-secret-xyz-')).status, 401);
    const noToken = (() => { delete process.env.DERIV_STATS_TOKEN; return run('cron-secret-xyz'); })();
    assert.match((await noToken).body.skipped, /DERIV_STATS_TOKEN/);
    process.env.DERIV_STATS_TOKEN = TOKEN;
    const today = C.todayUtc();
    const seen = fakeStats({});
    const ok = await run('cron-secret-xyz');
    assert.equal(ok.status, 200);
    assert.deepEqual(seen.map(s => new URL(s.url).searchParams.get('date_from')), [C.addDays(today, -2), C.addDays(today, -1), today]);
    fakeStats({}, { status: 504 });
    assert.equal((await run('cron-secret-xyz')).status, 502);
});

test('the schema can be run twice without error', async () => {
    const db = new PGlite();
    const text = fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8');
    await db.exec(text); await db.exec(text);
});
