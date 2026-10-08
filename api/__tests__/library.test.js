// Step 4: operator bots, strategy documents, bot requests, the public library and the admin controls.
// Real handlers + real SQL (in-memory Postgres). File storage is replaced by a fake.
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
const authApi = require('../auth');
const libraryApi = require('../library');
const publicApi = require('../site-library');
const A = require('../_lib/auth');
const L = require('../_lib/library');

const HOST = 'builder.test';

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
            json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); }, end() { resolve({ status: this.statusCode }); } };
        handler({ method, query, headers, body, socket: {} }, res);
    });
}
async function login(role, email) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Test', 'google', ${role}) RETURNING id`)[0];
    return { id: o.id, cookie: `${A.COOKIE_NAME}=${await A.createSession(sql, o.id)}` };
}
async function operator(email, subdomain) {
    const op = await login('operator', email);
    const r = await call(mySite, { method: 'POST', cookie: op.cookie, body: { name: subdomain, subdomain } });
    assert.equal(r.status, 201);
    op.site = (await sql`SELECT id, domain FROM sites WHERE owner_id = ${op.id}`)[0];
    return op;
}
const lib = (op, body) => call(libraryApi, { method: 'POST', cookie: op.cookie, body });
const adm = (a, body) => call(admin, { method: 'POST', cookie: a.cookie, body });

const XML = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="trade_definition"></block></xml>';
const botBody = (over = {}) => ({ action: 'add_bot', name: 'Even Odd Pro', description: 'Trades even/odd on 1s volatility.', market: 'Volatility 100 (1s)', risk_level: 'Medium', contract_type: 'Even/Odd', xml_content: XML, ...over });
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('hello strategy')]);
const stratBody = (over = {}) => ({ action: 'add_strategy', title: 'My martingale notes', description: 'How I size stakes', file_name: 'notes.pdf', file_base64: PDF.toString('base64'), ...over });

let stored, deleted;
function fakeBlob() {
    stored = {}; deleted = [];
    L.setBlob({
        put: async (key, buf, opts) => { stored[`https://blob.test/${key}`] = { size: buf.length, opts }; return { url: `https://blob.test/${key}` }; },
        del: async urls => { for (const u of [].concat(urls)) { deleted.push(u); delete stored[u]; } },
    });
}

test.beforeEach(async () => {
    await freshDb(); fakeBlob();
    process.env.PLATFORM_HOSTS = HOST; process.env.PLATFORM_ROOT_DOMAIN = 'free.test';
    delete process.env.BLOB_READ_WRITE_TOKEN;
});
test.afterEach(() => L.setBlob(null));

test('an operator adds a bot and it is live at once', async () => {
    const op = await operator('a@x.test', 'alpha');
    const r = await lib(op, botBody());
    assert.equal(r.status, 201);
    assert.equal(r.body.bots.length, 1);
    assert.equal(r.body.bots[0].status, 'live');
    assert.equal(r.body.bots[0].name, 'Even Odd Pro');
    assert.equal(r.body.bots[0].xml_content, undefined, 'the list never carries the bot file');
});

test('bot checks: missing fields, wrong risk, not a Deriv Bot file, dangerous XML, too big', async () => {
    const op = await operator('a@x.test', 'alpha');
    for (const [over, field] of [
        [{ name: '' }, 'name'], [{ description: ' ' }, 'description'], [{ market: '' }, 'market'],
        [{ risk_level: 'Extreme' }, 'risk_level'], [{ contract_type: 'Hax' }, 'contract_type'],
        [{ xml_content: '' }, 'xml_content'], [{ xml_content: '<html></html>' }, 'xml_content'],
        [{ xml_content: '<!DOCTYPE x [<!ENTITY a "b">]><xml></xml>' }, 'xml_content'],
        [{ xml_content: '<xml><script>alert(1)</script></xml>' }, 'xml_content'],
        [{ xml_content: `<xml>${'a'.repeat(L.LIMITS.botXml)}</xml>` }, 'xml_content'],
    ]) {
        const r = await lib(op, botBody(over));
        assert.equal(r.status, 400, JSON.stringify(over).slice(0, 60));
        assert.ok(r.body.fields[field], `${field} should be named`);
    }
    assert.equal((await sql`SELECT count(*)::int c FROM site_bots`)[0].c, 0);
});

test('an operator without a site cannot add anything; nobody signed in is refused', async () => {
    const op = await login('operator', 'b@x.test');
    assert.equal((await lib(op, botBody())).status, 400);
    assert.equal((await call(libraryApi, { method: 'GET' })).status, 401);
    assert.equal((await call(libraryApi, { method: 'POST', body: botBody() })).status, 401);
    const a = await login('admin', 'adm@x.test');
    assert.equal((await call(libraryApi, { cookie: a.cookie })).status, 403);
});

test('the bot limit per site holds, even for two uploads at the same moment', async () => {
    const op = await operator('a@x.test', 'alpha');
    for (let i = 0; i < L.LIMITS.botsPerSite - 1; i++) {
        await sql`INSERT INTO site_bots (site_id, owner_id, name, description, market, risk_level, xml_content) VALUES (${op.site.id}, ${op.id}, ${'b' + i}, 'd', 'm', 'Low', ${XML})`;
    }
    const rs = await Promise.all([lib(op, botBody({ name: 'one' })), lib(op, botBody({ name: 'two' }))]);
    assert.deepEqual(rs.map(r => r.status).sort(), [201, 400]);
    assert.equal((await sql`SELECT count(*)::int c FROM site_bots`)[0].c, L.LIMITS.botsPerSite);
});

test('editing keeps the old file unless a new one is sent; other operators cannot touch it', async () => {
    const op = await operator('a@x.test', 'alpha');
    const other = await operator('o@x.test', 'omega');
    const id = (await lib(op, botBody())).body.bots[0].id;
    const newXml = '<xml xmlns="x"><block type="b2"></block></xml>';
    let r = await lib(op, { ...botBody({ name: 'Renamed', xml_content: undefined }), action: 'update_bot', id });
    assert.equal(r.status, 200);
    assert.equal(r.body.bots[0].name, 'Renamed');
    assert.equal((await sql`SELECT xml_content FROM site_bots WHERE id = ${id}`)[0].xml_content, XML);
    r = await lib(op, { ...botBody({ xml_content: newXml }), action: 'update_bot', id });
    assert.equal((await sql`SELECT xml_content FROM site_bots WHERE id = ${id}`)[0].xml_content, newXml);
    assert.equal((await lib(other, { ...botBody(), action: 'update_bot', id })).status, 404);
    assert.equal((await lib(other, { action: 'delete_bot', id })).status, 404);
    assert.equal((await lib(op, { action: 'delete_bot', id })).status, 200);
    assert.equal((await sql`SELECT count(*)::int c FROM site_bots`)[0].c, 0);
});

test('visitors see only the live bots of an active site, never the file in the list or the owner', async () => {
    const op = await operator('a@x.test', 'alpha');
    const o2 = await operator('o@x.test', 'omega');
    const ids = [];
    for (const n of ['one', 'two']) ids.push((await lib(op, botBody({ name: n }))).body.bots[0].id);
    await lib(o2, botBody({ name: 'others' }));
    const host = op.site.domain;

    let r = await call(publicApi, { query: { host } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bots.map(b => b.name).sort(), ['one', 'two']);
    assert.equal(r.body.bots[0].xml_content, undefined);
    assert.ok(!JSON.stringify(r.body).includes('a@x.test'));
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');

    r = await call(publicApi, { query: { host: `www.${host}`, id: String(ids[0]) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.bot.xml_content, XML);
    // a bot of another site cannot be loaded through this site's host
    const foreign = (await sql`SELECT id FROM site_bots WHERE name = 'others'`)[0].id;
    assert.equal((await call(publicApi, { query: { host, id: String(foreign) } })).status, 404);
    assert.equal((await call(publicApi, { query: { host, id: 'abc' } })).status, 404);

    await sql`UPDATE sites SET status = 'suspended' WHERE id = ${op.site.id}`;
    assert.equal((await call(publicApi, { query: { host } })).status, 404);
    assert.equal((await call(publicApi, { query: { host, id: String(ids[0]) } })).status, 404);
    assert.equal((await call(publicApi, { query: {} })).status, 400);
    assert.equal((await call(publicApi, { method: 'POST', query: { host } })).status, 405);
});

test('the admin can take a bot down with a reason, the operator sees why, and it can be put back', async () => {
    const op = await operator('a@x.test', 'alpha');
    const a = await login('admin', 'adm@x.test');
    const id = (await lib(op, botBody())).body.bots[0].id;
    assert.equal((await adm(a, { action: 'library_remove', kind: 'bot', id })).status, 400, 'a reason is required');
    const r = await adm(a, { action: 'library_remove', kind: 'bot', id, note: 'Stake too aggressive' });
    assert.equal(r.status, 200);
    assert.equal(r.body.bots[0].status, 'removed');
    const mine = (await call(libraryApi, { cookie: op.cookie })).body.bots[0];
    assert.equal(mine.status, 'removed');
    assert.equal(mine.removed_note, 'Stake too aggressive');
    assert.equal((await call(publicApi, { query: { host: op.site.domain } })).body.bots.length, 0);
    assert.equal((await call(publicApi, { query: { host: op.site.domain, id: String(id) } })).status, 404);
    assert.equal((await lib(op, { ...botBody(), action: 'update_bot', id })).status, 404, 'a removed bot cannot be edited back to life');
    assert.equal((await adm(a, { action: 'library_remove', kind: 'bot', id, note: 'again' })).status, 404);
    assert.equal((await adm(a, { action: 'library_restore', kind: 'bot', id })).status, 200);
    assert.equal((await call(publicApi, { query: { host: op.site.domain } })).body.bots.length, 1);
    const o = await login('operator', 'z@x.test');
    assert.equal((await adm(o, { action: 'library_remove', kind: 'bot', id, note: 'x' })).status, 403);
});

test('a strategy document is checked, stored, listed and downloadable by its link', async () => {
    const op = await operator('a@x.test', 'alpha');
    const r = await lib(op, stratBody());
    assert.equal(r.status, 201);
    const s = r.body.strategies[0];
    assert.equal(s.title, 'My martingale notes');
    assert.match(s.url, /^https:\/\/blob\.test\/strategies\/\d+\/[0-9a-f]{16}-notes\.pdf$/);
    assert.equal(s.size_bytes, PDF.length);
    assert.equal(Object.values(stored)[0].opts.access, 'public');
    assert.equal(Object.values(stored)[0].opts.contentType, 'application/pdf');
    const pub = await call(publicApi, { query: { host: op.site.domain } });
    assert.equal(pub.body.strategies[0].url, s.url);
});

test('document checks: type, real contents, size, empty, no title, and storage switched off', async () => {
    const op = await operator('a@x.test', 'alpha');
    const exe = Buffer.from('MZ\x90\x00 not a pdf').toString('base64');
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(L.LIMITS.fileBytes)]).toString('base64');
    for (const [over, field] of [
        [{ file_name: 'virus.exe' }, 'file'], [{ file_name: 'noext' }, 'file'],
        [{ file_name: 'fake.pdf', file_base64: exe }, 'file'],
        [{ file_name: 'fake.docx', file_base64: PDF.toString('base64') }, 'file'],
        [{ file_base64: big }, 'file'], [{ file_base64: '' }, 'file'], [{ file_base64: '***' }, 'file'],
        [{ title: '' }, 'title'],
    ]) {
        const r = await lib(op, stratBody(over));
        assert.equal(r.status, 400, JSON.stringify(over).slice(0, 50));
        assert.ok(r.body.fields[field]);
    }
    assert.deepEqual(Object.keys(stored), [], 'nothing was stored for rejected files');
    // paths in the file name cannot escape the folder
    const ok = await lib(op, stratBody({ file_name: '../../etc/passwd.txt', file_base64: Buffer.from('hi').toString('base64') }));
    assert.equal(ok.status, 201);
    assert.ok(!ok.body.strategies[0].url.includes('..'));
    // storage not configured
    L.setBlob(null);
    const off = await lib(op, stratBody());
    assert.equal(off.status, 503);
    assert.equal((await call(libraryApi, { cookie: op.cookie })).body.storage_ready, false);
});

test('a failed upload to storage saves nothing; the document limit holds', async () => {
    const op = await operator('a@x.test', 'alpha');
    L.setBlob({ put: async () => { throw new Error('boom secret-token'); }, del: async () => {} });
    const r = await lib(op, stratBody());
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes('secret-token'));
    assert.equal((await sql`SELECT count(*)::int c FROM site_strategies`)[0].c, 0);
    fakeBlob();
    for (let i = 0; i < L.LIMITS.strategiesPerSite; i++) {
        await sql`INSERT INTO site_strategies (site_id, owner_id, title, file_name, mime, size_bytes, blob_url) VALUES (${op.site.id}, ${op.id}, 't', 'f.pdf', 'application/pdf', 1, ${'https://blob.test/x' + i})`;
    }
    assert.equal((await lib(op, stratBody())).status, 400);
    assert.deepEqual(Object.keys(stored), []);
});

test('deleting or removing a document deletes the stored file, so the old link stops working', async () => {
    const op = await operator('a@x.test', 'alpha');
    const a = await login('admin', 'adm@x.test');
    const other = await operator('o@x.test', 'omega');
    let r = await lib(op, stratBody({ title: 'one' }));
    await lib(op, stratBody({ title: 'two' }));
    const [two, one] = r.body ? (await call(libraryApi, { cookie: op.cookie })).body.strategies : [];
    assert.equal((await lib(other, { action: 'delete_strategy', id: one.id })).status, 404);
    assert.equal((await lib(op, { action: 'delete_strategy', id: one.id })).status, 200);
    assert.ok(deleted.includes(one.url));
    assert.ok(!(one.url in stored));
    assert.equal((await adm(a, { action: 'library_remove', kind: 'strategy', id: two.id, note: 'Not allowed' })).status, 200);
    assert.ok(deleted.includes(two.url));
    const mine = (await call(libraryApi, { cookie: op.cookie })).body.strategies[0];
    assert.equal(mine.status, 'removed');
    assert.equal(mine.url, '', 'the link is hidden once removed');
    assert.equal((await call(publicApi, { query: { host: op.site.domain } })).body.strategies.length, 0);
    assert.equal((await adm(a, { action: 'library_restore', kind: 'strategy', id: two.id })).status, 400);
});

test('deleting a site, an operator account, or your own account deletes their stored files', async () => {
    const a = await login('admin', 'adm@x.test');
    const o1 = await operator('a@x.test', 'alpha');
    const o2 = await operator('b@x.test', 'beta');
    const o3 = await operator('c@x.test', 'gamma');
    for (const o of [o1, o2, o3]) await lib(o, stratBody());
    assert.equal(Object.keys(stored).length, 3);
    assert.equal((await adm(a, { action: 'delete_site', site_id: o1.site.id })).status, 200);
    assert.equal(Object.keys(stored).length, 2);
    assert.equal((await adm(a, { action: 'delete_owner', owner_id: o2.id })).status, 200);
    assert.equal(Object.keys(stored).length, 1);
    const r = await call(authApi, { method: 'POST', query: { action: 'delete_account' }, cookie: o3.cookie, body: { confirm: 'DELETE' } });
    assert.equal(r.status, 200);
    assert.equal(Object.keys(stored).length, 0);
    assert.equal((await sql`SELECT count(*)::int c FROM site_strategies`)[0].c, 0);
});

test('a bot request: needs detail, five open at most, the admin answers, declining needs a reason', async () => {
    const op = await operator('a@x.test', 'alpha');
    const a = await login('admin', 'adm@x.test');
    assert.equal((await lib(op, { action: 'request_bot', title: '', details: 'something long enough' })).status, 400);
    assert.equal((await lib(op, { action: 'request_bot', title: 'Bot', details: 'short' })).status, 400);
    for (let i = 0; i < L.LIMITS.openRequests; i++) assert.equal((await lib(op, { action: 'request_bot', title: 'Idea ' + i, details: 'Please build a bot that does idea ' + i })).status, 201);
    assert.equal((await lib(op, { action: 'request_bot', title: 'Too many', details: 'Please build one more bot' })).status, 400);
    const reqs = (await call(libraryApi, { cookie: op.cookie })).body.requests;
    assert.equal(reqs.length, 5);
    assert.equal((await adm(a, { action: 'request_answer', id: reqs[0].id, status: 'declined' })).status, 400);
    assert.equal((await adm(a, { action: 'request_answer', id: reqs[0].id, status: 'declined', note: 'Not possible on Deriv' })).status, 200);
    assert.equal((await adm(a, { action: 'request_answer', id: reqs[1].id, status: 'done', note: 'Added to the library' })).status, 200);
    assert.equal((await adm(a, { action: 'request_answer', id: reqs[1].id, status: 'done' })).status, 404, 'answered once');
    assert.equal((await adm(a, { action: 'request_answer', id: reqs[2].id, status: 'maybe' })).status, 400);
    const after = (await call(libraryApi, { cookie: op.cookie })).body.requests;
    assert.equal(after.find(x => x.id === reqs[0].id).admin_note, 'Not possible on Deriv');
    // answered requests free up space; cancelling works for the owner only
    assert.equal((await lib(op, { action: 'request_bot', title: 'Again', details: 'Please build another bot' })).status, 201);
    const other = await operator('o@x.test', 'omega');
    assert.equal((await lib(other, { action: 'cancel_request', id: reqs[2].id })).status, 404);
    assert.equal((await lib(op, { action: 'cancel_request', id: reqs[2].id })).status, 200);
    assert.equal((await lib(op, { action: 'cancel_request', id: reqs[2].id })).status, 404);
});

test('operators only ever see their own things, and the admin view shows everyone with owner and site', async () => {
    const op = await operator('a@x.test', 'alpha');
    const o2 = await operator('o@x.test', 'omega');
    const a = await login('admin', 'adm@x.test');
    await lib(op, botBody({ name: 'mine' })); await lib(o2, botBody({ name: 'theirs' }));
    await lib(op, stratBody()); await lib(o2, { action: 'request_bot', title: 'T', details: 'Please build me a thing' });
    const mine = (await call(libraryApi, { cookie: op.cookie })).body;
    assert.deepEqual(mine.bots.map(b => b.name), ['mine']);
    assert.equal(mine.requests.length, 0);
    assert.ok(!JSON.stringify(mine).includes('o@x.test'));
    const view = (await call(admin, { query: { resource: 'library' }, cookie: a.cookie })).body;
    assert.equal(view.bots.length, 2); assert.equal(view.strategies.length, 1); assert.equal(view.requests.length, 1);
    assert.ok(view.bots.every(b => b.owner_email && b.site_domain));
    assert.equal(view.bots[0].xml_content, undefined, 'the admin list does not carry bot files either');
    assert.equal((await call(admin, { query: { resource: 'library' }, cookie: op.cookie })).status, 403);
});

test('cross-site posts are refused', async () => {
    const op = await operator('a@x.test', 'alpha');
    const r = await call(libraryApi, { method: 'POST', cookie: op.cookie, headers: { origin: 'https://evil.test' }, body: botBody() });
    assert.equal(r.status, 403);
});

test('the schema can be run twice without error', async () => {
    const db = new PGlite();
    const text = fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8');
    await db.exec(text); await db.exec(text);
});
