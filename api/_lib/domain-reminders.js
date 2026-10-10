// Emails operators before a domain we sold them expires (30, 14 and 7 days out) and once when it has expired.
// Runs in the daily visit (see domain-orders.js sweep). Does nothing until email is set up (see email.js).
//   - Only the most urgent level that applies is sent, so a site found at 6 days gets one email, not three.
//   - Each (site, level, expiry date) is emailed once. A renewal moves the expiry date, which starts a fresh cycle.
//   - If sending fails, the record is removed so tomorrow's visit tries again.

const E = require('./email');
const { logEvent } = require('./events');

const MAX_PER_RUN = 50;

const levelFor = days => (days < 0 ? 'expired' : days <= 7 ? 'd7' : days <= 14 ? 'd14' : days <= 30 ? 'd30' : null);

const appUrl = () => {
    const explicit = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const host = String(process.env.PLATFORM_HOSTS || '').split(',')[0].trim();
    return host ? `https://${host}` : '';
};

function compose(level, domain, expires, days, name) {
    const date = expires.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const link = appUrl() ? `${appUrl()}/app#/domains` : 'your dashboard (Domains, then Renew)';
    const hi = `Hello${name ? ' ' + String(name).split(' ')[0] : ''},\n\n`;
    const how = `\n\nTo renew, open ${link}, go to the Renew tab and pay by M-Pesa. The price is shown there before you pay.\n\nIf you do nothing, we do not charge you anything and the domain is not renewed.`;
    if (level === 'expired') {
        return { subject: `Your domain ${domain} has expired and your site is paused`,
            text: `${hi}Your domain ${domain} expired on ${date}, so your site is paused and visitors cannot reach it.\n\nRenew it to bring your site back.${how}` };
    }
    const when = days === 1 ? 'tomorrow' : `in ${days} days`;
    return { subject: `Your domain ${domain} expires ${when}`,
        text: `${hi}Your domain ${domain} expires on ${date} (${when}). After that your site will be paused until you renew.${how}` };
}

// Returns { sent, failed }.
async function sendReminders(sql) {
    if (!E.isConfigured()) return { sent: 0, failed: 0, skipped: true };
    const sites = await sql`
        SELECT s.id, s.domain, s.domain_expires_at, o.email, o.name
        FROM sites s JOIN owners o ON o.id = s.owner_id
        WHERE s.domain_bought_here = true AND s.domain_expires_at IS NOT NULL AND s.domain_expires_at < now() + interval '31 days' AND s.domain_expires_at > now() - interval '7 days'
        ORDER BY s.domain_expires_at LIMIT 500`;
    let sent = 0, failed = 0;
    for (const s of sites) {
        if (sent + failed >= MAX_PER_RUN) break;
        const expires = new Date(s.domain_expires_at);
        const days = Math.ceil((expires.getTime() - Date.now()) / 86400000);
        const level = levelFor(days);
        if (!level) continue;
        const on = expires.toISOString().slice(0, 10);
        const claimed = await sql`INSERT INTO domain_reminders (site_id, level, expires_on) VALUES (${s.id}, ${level}, ${on}) ON CONFLICT (site_id, level, expires_on) DO NOTHING RETURNING id`;
        if (!claimed.length) continue;
        const mail = compose(level, s.domain, expires, days, s.name);
        const r = await E.sendEmail({ to: s.email, subject: mail.subject, text: mail.text });
        if (r.ok) { sent++; await logEvent(sql, s.id, 'domain_reminder_sent', { level }); }
        else { failed++; await sql`DELETE FROM domain_reminders WHERE id = ${claimed[0].id}`; console.error('reminder not sent:', r.error); }
    }
    return { sent, failed };
}

module.exports = { sendReminders, levelFor, compose };
