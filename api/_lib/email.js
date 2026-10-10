// Sends plain emails through Resend (resend.com), over its REST API. Off until you set the two settings below.
//   RESEND_API_KEY   the API key from your Resend account
//   EMAIL_FROM       the sender, for example  EPM Website Builder <noreply@yourdomain.com>
//                    The domain in it must be verified in Resend, or Resend only lets you email yourself.
// UNTESTED against live Resend: the first real reminder is the real test.

const env = k => String(process.env[k] || '').trim();
const TIMEOUT_MS = 10000;

const isConfigured = () => !!(env('RESEND_API_KEY') && env('EMAIL_FROM'));

async function defaultTransport(url, options) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...options, signal: ctl.signal });
        let body = null;
        try { body = await r.json(); } catch (e) { /* not JSON */ }
        return { status: r.status, body };
    } finally { clearTimeout(timer); }
}
let transport = defaultTransport;
const setTransport = fn => { transport = fn || defaultTransport; };

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// Returns { ok:true } or { ok:false, error }. Never throws, and never returns the API key.
async function sendEmail({ to, subject, text }) {
    if (!isConfigured()) return { ok: false, error: 'Email is not set up.' };
    if (!EMAIL.test(String(to || ''))) return { ok: false, error: 'Not a valid email address.' };
    let res;
    try {
        res = await transport('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: env('EMAIL_FROM'), to: [to], subject: String(subject).slice(0, 200), text: String(text).slice(0, 5000) }),
        });
    } catch (err) { return { ok: false, error: 'Could not reach the email service.' }; }
    if (res && (res.status === 200 || res.status === 201)) return { ok: true };
    const why = res && res.body && (res.body.message || res.body.name) ? String(res.body.message || res.body.name).replace(/[\r\n]+/g, ' ').slice(0, 120) : `error ${(res && res.status) || 'no reply'}`;
    return { ok: false, error: `The email service refused it: ${why}` };
}

module.exports = { isConfigured, sendEmail, setTransport };
