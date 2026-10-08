const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const C = require('./_lib/commissions');

const send = (res, code, body) => res.status(code).json(body);

const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

// Called once a day by Vercel Cron (see vercel.json). Refreshes today and the two days before it from Deriv.
// Needs CRON_SECRET in Vercel: Vercel then sends it as "Authorization: Bearer <secret>". Without it the endpoint refuses everything.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) return send(res, 503, { error: 'CRON_SECRET is not set.' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!sameSecret(given, secret)) return send(res, 401, { error: 'Not allowed.' });
    if (!C.isConfigured()) return send(res, 200, { skipped: 'DERIV_STATS_TOKEN is not set.' });

    try {
        const sql = getDb();
        const today = C.todayUtc();
        const results = await C.syncRange(sql, C.addDays(today, -2), today);
        const failed = results.find(r => r.error);
        return send(res, failed ? 502 : 200, { results });
    } catch (err) {
        console.error('cron-commissions error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
