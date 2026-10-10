// Emailing operators before a domain expires. Real SQL (in-memory Postgres); the email service is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

let sql;
const dbPath = require.resolve('../_lib/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
const E = require('../_lib/email');
const Rem = require('../_lib/domain-reminders');
const DO = require('../_lib/domain-orders');

const KEY = 'RESEND-KEY-SECRET-123';

async function freshDb() {
    const db = new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname, '../_lib/schema.sql'), 'utf8'));
    sql = async (strings, ...vals) => {
        let q = ''; strings.forEach((s, i) => { q += s; if (i < vals.length) q += `$${i + 1}`; });
        return (await db.query(q, vals.map(v => (v === undefined ? null : v)))).rows;
    };
}
let sent, reply;
function fakeEmail() {
    sent = []; reply = { status: 200, body: { id: 'em_1' } };
    E.setTransport(async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); if (reply instanceof Error) throw reply; return reply; });
}
async function bought(email, domain, days) {
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, 'Julia Wanjiru', 'google', 'operator') RETURNING id`)[0];
    const s = (await sql`INSERT INTO sites (owner_id, name, domain, plan, status, domain_bought_here, domain_expires_at)
                         VALUES (${o.id}, 'Shop', ${domain}, 'custom', 'active', true, now() + (${days} || ' days')::interval) RETURNING id`)[0];
    return s.id;
}

test.beforeEach(async () => {
    await freshDb(); fakeEmail();
    process.env.RESEND_API_KEY = KEY; process.env.EMAIL_FROM = 'EPM <noreply@example.com>'; process.env.PLATFORM_HOSTS = 'builder.test';
    delete process.env.APP_BASE_URL;
});
test.afterEach(() => { E.setTransport(null); delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.PLATFORM_HOSTS; });

// ---------- the email sender ----------
test('with no settings it sends nothing; with them it sends one correct request', async () => {
    delete process.env.RESEND_API_KEY;
    assert.equal(E.isConfigured(), false);
    assert.equal((await E.sendEmail({ to: 'a@example.com', subject: 's', text: 't' })).ok, false);
    assert.equal(sent.length, 0);

    process.env.RESEND_API_KEY = KEY;
    const r = await E.sendEmail({ to: 'a@example.com', subject: 'Hello', text: 'Body' });
    assert.deepEqual(r, { ok: true });
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal(sent[0].options.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(sent[0].body, { from: 'EPM <noreply@example.com>', to: ['a@example.com'], subject: 'Hello', text: 'Body' });
});

test('bad addresses and service failures are reported plainly, never with the key', async () => {
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', null]) assert.equal((await E.sendEmail({ to: bad, subject: 's', text: 't' })).ok, false, String(bad));
    assert.equal(sent.length, 0);
    reply = { status: 403, body: { name: 'validation_error', message: 'The domain is not verified' } };
    const refused = await E.sendEmail({ to: 'a@example.com', subject: 's', text: 't' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not verified/);
    reply = new Error('socket hang up');
    const down = await E.sendEmail({ to: 'a@example.com', subject: 's', text: 't' });
    assert.match(down.error, /Could not reach/);
    for (const x of [refused, down]) assert.ok(!JSON.stringify(x).includes(KEY));
});

// ---------- the reminders ----------
test('which reminder applies', () => {
    assert.deepEqual([45, 31, 30, 15, 14, 8, 7, 1, 0, -1].map(Rem.levelFor), [null, null, 'd30', 'd30', 'd14', 'd14', 'd7', 'd7', 'd7', 'expired']);
});

test('each expiry stage emails the operator once, in plain words with a link', async () => {
    const id = await bought('o@example.com', 'mybrand.com', 20);
    let r = await Rem.sendReminders(sql);
    assert.deepEqual(r, { sent: 1, failed: 0 });
    assert.equal(sent[0].body.to[0], 'o@example.com');
    assert.match(sent[0].body.subject, /mybrand\.com expires in 2\d days|expires in 19 days|expires in 20 days/);
    assert.match(sent[0].body.text, /Hello Julia,/);
    assert.match(sent[0].body.text, /https:\/\/builder\.test\/app#\/domains/);
    assert.match(sent[0].body.text, /we do not charge you anything/);
    assert.ok(!sent[0].body.text.includes(KEY));

    r = await Rem.sendReminders(sql);                                   // same day again: nothing
    assert.equal(r.sent, 0);
    assert.equal(sent.length, 1);

    await sql`UPDATE sites SET domain_expires_at = now() + interval '10 days' WHERE id = ${id}`;
    assert.equal((await Rem.sendReminders(sql)).sent, 1);               // now the 14-day stage
    await sql`UPDATE sites SET domain_expires_at = now() + interval '3 days' WHERE id = ${id}`;
    assert.equal((await Rem.sendReminders(sql)).sent, 1);               // the 7-day stage
    await sql`UPDATE sites SET domain_expires_at = now() - interval '1 day' WHERE id = ${id}`;
    assert.equal((await Rem.sendReminders(sql)).sent, 1);               // expired
    assert.match(sent[3].body.subject, /has expired and your site is paused/);
    assert.equal((await Rem.sendReminders(sql)).sent, 0);
    assert.equal(sent.length, 4);
    assert.ok((await sql`SELECT event FROM site_events WHERE site_id = ${id}`).some(e => e.event === 'domain_reminder_sent'));
});

test('a site found late gets only its most urgent reminder, not a pile', async () => {
    await bought('o@example.com', 'mybrand.com', 5);
    assert.equal((await Rem.sendReminders(sql)).sent, 1);
    assert.match(sent[0].body.subject, /expires in [45] days/);
    assert.equal((await Rem.sendReminders(sql)).sent, 0);
});

test('only domains we sold, only the owner, only close to expiry', async () => {
    await bought('far@example.com', 'far.com', 90);
    const o = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES ('own@example.com', 'Own', 'google', 'operator') RETURNING id`)[0];
    await sql`INSERT INTO sites (owner_id, name, domain, plan, status, domain_bought_here, domain_expires_at) VALUES (${o.id}, 'X', 'own.com', 'custom', 'active', false, now() + interval '3 days')`;
    const old = await bought('old@example.com', 'old.com', -30);        // long expired: no email now
    assert.deepEqual(await Rem.sendReminders(sql), { sent: 0, failed: 0 });
    assert.equal(sent.length, 0);
    assert.ok(old);
});

test('if sending fails the record is removed so the next daily visit tries again', async () => {
    await bought('o@example.com', 'mybrand.com', 3);
    reply = { status: 500, body: null };
    assert.deepEqual(await Rem.sendReminders(sql), { sent: 0, failed: 1 });
    assert.equal((await sql`SELECT count(*)::int AS n FROM domain_reminders`)[0].n, 0);
    reply = { status: 200, body: { id: 'em_2' } };
    assert.deepEqual(await Rem.sendReminders(sql), { sent: 1, failed: 0 });
    assert.equal((await sql`SELECT count(*)::int AS n FROM domain_reminders`)[0].n, 1);
});

test('without email set up, nothing is recorded and nothing is sent', async () => {
    await bought('o@example.com', 'mybrand.com', 3);
    delete process.env.EMAIL_FROM;
    const r = await Rem.sendReminders(sql);
    assert.equal(r.sent, 0); assert.equal(r.skipped, true);
    assert.equal(sent.length, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM domain_reminders`)[0].n, 0);
});

test('a renewal starts a fresh cycle, because the expiry date moves', async () => {
    const id = await bought('o@example.com', 'mybrand.com', 3);
    await Rem.sendReminders(sql);
    await sql`UPDATE sites SET domain_expires_at = domain_expires_at + interval '1 year' WHERE id = ${id}`;
    assert.equal((await Rem.sendReminders(sql)).sent, 0);               // a year away: nothing
    await sql`UPDATE sites SET domain_expires_at = now() + interval '3 days' WHERE id = ${id}`;
    await sql`UPDATE domain_reminders SET expires_on = expires_on - 400`;   // the old cycle's records are for an older date
    assert.equal((await Rem.sendReminders(sql)).sent, 1);
});

test('the daily sweep sends the reminders and reports them', async () => {
    await bought('o@example.com', 'mybrand.com', 3);
    const r = await DO.sweep(sql);
    assert.equal(r.reminders.sent, 1);
    assert.equal(sent.length, 1);
});

test('the link falls back to APP_BASE_URL when you set one, and to plain words when there is no address', async () => {
    await bought('a@example.com', 'a.com', 3);
    process.env.APP_BASE_URL = 'https://app.mybuilder.co.ke/';
    await Rem.sendReminders(sql);
    assert.match(sent[0].body.text, /https:\/\/app\.mybuilder\.co\.ke\/app#\/domains/);
    delete process.env.APP_BASE_URL; delete process.env.PLATFORM_HOSTS;
    await bought('b@example.com', 'b.com', 3);
    await Rem.sendReminders(sql);
    assert.match(sent[1].body.text, /your dashboard \(Domains, then Renew\)/);
});
