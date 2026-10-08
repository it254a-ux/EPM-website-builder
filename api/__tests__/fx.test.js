// Daily USD to KES rate. Real SQL (in-memory Postgres); the rate source is replaced by a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const FX = require('../_lib/fx');
const cron = require('../cron-fx');

async function freshDb() {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8'));
    sql = async (strings, ...vals) => {
        let q = ''; strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
        return (await db.query(q, vals.map(v => (v === undefined ? null : v)))).rows;
    };
}
const fake = reply => { const calls = []; FX.setTransport(async url => { calls.push(url); if (reply instanceof Error) throw reply; return reply; }); return calls; };
const ok = kes => ({ status: 200, body: { result: 'success', base_code: 'USD', rates: { USD: 1, KES: kes } } });
const rows = async () => sql`SELECT rate FROM fx_rates ORDER BY id`;
const runCron = (headers = {}, method = 'GET') => new Promise(resolve => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    cron({ method, headers }, res);
});

test.beforeEach(async () => { await freshDb(); delete process.env.KES_PER_USD; delete process.env.FX_API_URL; process.env.CRON_SECRET = 'cron-secret-xyz'; });
test.afterEach(() => { FX.setTransport(null); delete process.env.KES_PER_USD; delete process.env.FX_API_URL; delete process.env.CRON_SECRET; });

test('a good answer is stored and becomes the current rate', async () => {
    const calls = fake(ok(129.4));
    const r = await FX.refreshRate(sql);
    assert.deepEqual(r, { ok: true, rate: 129.4 });
    assert.equal(calls[0], 'https://open.er-api.com/v6/latest/USD');
    const cur = await FX.currentRate(sql);
    assert.equal(cur.rate, 129.4);
    assert.equal(cur.source, 'live');
});

test('answers that cannot be used are refused and nothing is stored', async () => {
    for (const reply of [
        { status: 500, body: null },
        { status: 200, body: { result: 'error', 'error-type': 'quota-reached' } },
        { status: 200, body: { result: 'success', rates: {} } },
        { status: 200, body: { result: 'success', rates: { KES: 'abc' } } },
        { status: 200, body: { result: 'success', rates: { KES: 0 } } },
        { status: 200, body: { result: 'success', rates: { KES: 5 } } },       // far too low
        { status: 200, body: { result: 'success', rates: { KES: 5000 } } },    // far too high
    ]) {
        fake(reply);
        assert.equal((await FX.refreshRate(sql)).ok, false, JSON.stringify(reply));
    }
    fake(new Error('network down'));
    assert.equal((await FX.refreshRate(sql)).ok, false);
    assert.equal((await rows()).length, 0);
});

test('a sudden jump of more than 15 percent is not trusted, the old rate stays', async () => {
    fake(ok(130)); await FX.refreshRate(sql);
    fake(ok(160));
    const r = await FX.refreshRate(sql);
    assert.equal(r.ok, false);
    assert.match(r.reason, /more than 15%/);
    assert.equal((await FX.currentRate(sql)).rate, 130);
    fake(ok(135));                                           // a normal move is accepted
    assert.equal((await FX.refreshRate(sql)).ok, true);
    assert.equal((await FX.currentRate(sql)).rate, 135);
});

test('after a long gap a big change is accepted again', async () => {
    fake(ok(130)); await FX.refreshRate(sql);
    await sql`UPDATE fx_rates SET fetched_at = now() - interval '10 days'`;
    fake(ok(160));
    assert.equal((await FX.refreshRate(sql)).ok, true);
});

test('an old stored rate is not used: it falls back to the number you typed, or to nothing', async () => {
    fake(ok(130)); await FX.refreshRate(sql);
    await sql`UPDATE fx_rates SET fetched_at = now() - interval '3 days'`;
    assert.equal(await FX.currentRate(sql), null);
    process.env.KES_PER_USD = '128.5';
    assert.deepEqual(await FX.currentRate(sql), { rate: 128.5, source: 'manual', fetchedAt: null });
    process.env.KES_PER_USD = 'nonsense';
    assert.equal(await FX.currentRate(sql), null);
});

test('with no stored rate and nothing typed in, there is no rate', async () => {
    assert.equal(await FX.currentRate(sql), null);
});

test('the daily job refuses callers without the secret, and works with it', async () => {
    const calls = fake(ok(129.4));
    assert.equal((await runCron({})).status, 401);
    assert.equal((await runCron({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal(calls.length, 0);
    const good = await runCron({ authorization: 'Bearer cron-secret-xyz' });
    assert.equal(good.status, 200);
    assert.equal(good.body.rate, 129.4);
    delete process.env.CRON_SECRET;
    assert.equal((await runCron({ authorization: 'Bearer cron-secret-xyz' })).status, 503);
});

test('the daily job reports a bad answer as an error', async () => {
    fake({ status: 200, body: { result: 'error' } });
    const r = await runCron({ authorization: 'Bearer cron-secret-xyz' });
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
});

test('the daily job is scheduled in vercel.json', () => {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
    assert.ok(v.crons.some(c => c.path === '/api/cron-fx'));
    assert.ok(v.crons.some(c => c.path === '/api/cron-commissions'));
});
