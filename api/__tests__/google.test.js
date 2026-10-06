// Google sign-in tests. Real handlers + real SQL (in-memory Postgres); Google's token endpoint is faked.
// Run with:  npm run test:api
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const google = require('../google');
const auth = require('../auth');
const A = require('../_lib/auth');

const CLIENT_ID = 'test-client.apps.googleusercontent.com', SECRET = 'test-secret';
const HOST = 'developderiv.test';

async function freshDb() {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8'));
    sql = async (strings, ...vals) => {
        let q = ''; strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
        return (await db.query(q, vals.map(v => (v === undefined ? null : v)))).rows;
    };
}
function call(handler, { method = 'GET', query = {}, body, cookie, host = HOST } = {}) {
    return new Promise(resolve => {
        const headers = { host, 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' };
        if (cookie) headers.cookie = cookie;
        const res = {
            statusCode: 200, headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
            end() { resolve({ status: this.statusCode, headers: this.headers }); },
        };
        handler({ method, query, headers, body, socket: {} }, res);
    });
}
const cookies = r => [].concat(r.headers['Set-Cookie'] || []);
const jar = r => cookies(r).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
const idToken = over => {
    const p = { iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, email: 'sam@gmail.com', email_verified: true, name: 'Sam Google', ...over };
    return `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
};
// Runs the whole round trip. `claims` lets a test tamper with what Google "returns".
async function roundTrip({ terms = '1', claims = {}, tamperState, dropCookie, expectToken = true } = {}) {
    const start = await call(google, { query: { start: '1', terms } });
    const loc = new URL(start.headers.Location);
    const state = loc.searchParams.get('state'), nonce = loc.searchParams.get('nonce');
    global.fetch = async () => ({ ok: expectToken, json: async () => ({ id_token: idToken({ nonce, ...claims }) }) });
    return call(google, { query: { code: 'abc', state: tamperState || state }, cookie: dropCookie ? undefined : jar(start) });
}

test.beforeEach(async () => {
    await freshDb();
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID; process.env.GOOGLE_CLIENT_SECRET = SECRET;
    process.env.PLATFORM_HOSTS = HOST; delete process.env.GOOGLE_REDIRECT_URI;
});

test('is off until the Google keys are set', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const r = await call(google, { query: { start: '1', terms: '1' } });
    assert.equal(r.status, 302); assert.equal(r.headers.Location, '/app/?google=unavailable');
    assert.equal((await call(auth, { query: { action: 'me' } })).body.google, false);
});

test('start sends the browser to Google with the right parameters and a signed, short-lived cookie', async () => {
    const r = await call(google, { query: { start: '1', terms: '1' } });
    const u = new URL(r.headers.Location);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('redirect_uri'), `https://${HOST}/api/google`);
    assert.equal(u.searchParams.get('scope'), 'openid email profile');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.ok(u.searchParams.get('state').length >= 32 && u.searchParams.get('nonce').length >= 32);
    const c = cookies(r)[0];
    assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/); assert.match(c, /Max-Age=600/);
    assert.equal((await call(auth, { query: { action: 'me' } })).body.google, true);
});

test('a new person with the terms ticked gets an operator account and a session', async () => {
    const r = await roundTrip();
    assert.equal(r.status, 302); assert.equal(r.headers.Location, '/app/');
    const owner = (await sql`SELECT email, name, role, password_hash FROM owners`)[0];
    assert.deepEqual({ ...owner }, { email: 'sam@gmail.com', name: 'Sam Google', role: 'operator', password_hash: 'google' });
    const log = await sql`SELECT action, detail FROM audit_log`;
    assert.equal(log[0].action, 'terms_accepted'); assert.equal(log[0].detail.via, 'google');
    const me = await call(auth, { query: { action: 'me' }, cookie: jar(r) });
    assert.equal(me.body.owner.email, 'sam@gmail.com'); assert.equal(me.body.owner.has_password, false);
});

test('a new person who has not ticked the terms is sent back and nothing is created', async () => {
    const r = await roundTrip({ terms: '0' });
    assert.equal(r.headers.Location, '/app/?google=terms');
    assert.equal((await sql`SELECT 1 FROM owners`).length, 0);
});

test('an existing Google account just signs in, even without the terms box', async () => {
    await roundTrip();
    const again = await roundTrip({ terms: '0' });
    assert.equal(again.headers.Location, '/app/');
    assert.equal((await sql`SELECT 1 FROM owners`).length, 1);
});

test('rejects a wrong state, a missing cookie, a tampered cookie, and a denied request', async () => {
    assert.equal((await roundTrip({ tamperState: 'x'.repeat(32) })).headers.Location, '/app/?google=error');
    assert.equal((await roundTrip({ dropCookie: true })).headers.Location, '/app/?google=error');
    const start = await call(google, { query: { start: '1', terms: '0' } });
    const state = new URL(start.headers.Location).searchParams.get('state');
    const forged = A.parseCookies(jar(start)).epm_oauth.split('.');
    const body = JSON.parse(Buffer.from(forged[0], 'base64url')); body.t = 1;
    const tampered = `epm_oauth=${Buffer.from(JSON.stringify(body)).toString('base64url')}.${forged[1]}`;
    global.fetch = async () => ({ ok: true, json: async () => ({ id_token: idToken({ nonce: body.n }) }) });
    assert.equal((await call(google, { query: { code: 'abc', state }, cookie: tampered })).headers.Location, '/app/?google=error');
    assert.equal((await call(google, { query: { error: 'access_denied' } })).headers.Location, '/app/?google=denied');
    assert.equal((await sql`SELECT 1 FROM owners`).length, 0);
});

test('rejects unverified emails, wrong audience, wrong issuer, wrong nonce, expired tokens and failed exchanges', async () => {
    for (const claims of [{ email_verified: false }, { aud: 'someone-else' }, { iss: 'https://evil.example' }, { nonce: 'wrong' }, { exp: 1 }]) {
        assert.equal((await roundTrip({ claims })).headers.Location, '/app/?google=error', JSON.stringify(claims));
    }
    assert.equal((await roundTrip({ expectToken: false })).headers.Location, '/app/?google=error');
    assert.equal((await sql`SELECT 1 FROM owners`).length, 0);
});

test('an existing password account is taken over by the verified Google owner: password off, old sessions ended', async () => {
    const hash = await A.hashPassword('attacker chosen password');
    const id = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES ('sam@gmail.com','Squatter',${hash},'operator') RETURNING id`)[0].id;
    const oldSession = await A.createSession(sql, id);
    const r = await roundTrip({ terms: '0' });
    assert.equal(r.headers.Location, '/app/');
    assert.equal((await sql`SELECT password_hash FROM owners WHERE id = ${id}`)[0].password_hash, 'google');
    const stale = await call(auth, { query: { action: 'me' }, cookie: `epm_session=${oldSession}` });
    assert.equal(stale.body.owner, null);
    const login = await call(auth, { method: 'POST', query: { action: 'login' }, body: { email: 'sam@gmail.com', password: 'attacker chosen password' } });
    assert.equal(login.status, 401);
    assert.equal((await sql`SELECT action FROM audit_log WHERE action = 'google_linked'`).length, 1);
});

test('admin and disabled accounts can never use Google sign-in', async () => {
    await sql`INSERT INTO owners (email, name, password_hash, role) VALUES ('sam@gmail.com','Boss','x','admin')`;
    assert.equal((await roundTrip()).headers.Location, '/app/?google=admin');
    await sql`UPDATE owners SET role = 'operator', disabled = true`;
    assert.equal((await roundTrip()).headers.Location, '/app/?google=disabled');
});

test('Google-only accounts can delete themselves with just the word DELETE', async () => {
    const r = await roundTrip();
    const cookie = jar(r);
    const wrong = await call(auth, { method: 'POST', query: { action: 'delete_account' }, body: { confirm: 'yes' }, cookie });
    assert.equal(wrong.status, 400);
    const ok = await call(auth, { method: 'POST', query: { action: 'delete_account' }, body: { confirm: 'DELETE' }, cookie });
    assert.equal(ok.status, 200);
    assert.equal((await sql`SELECT 1 FROM owners`).length, 0);
});

test('answers 404 on a domain that is not one of yours', async () => {
    const r = await call(google, { query: { start: '1', terms: '1' }, host: 'someone-else.com' });
    assert.equal(r.status, 404);
});
