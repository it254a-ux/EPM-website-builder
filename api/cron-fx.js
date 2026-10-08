const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const FX = require('./_lib/fx');

const send = (res, code, body) => res.status(code).json(body);
const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

// Called once a day by Vercel Cron (see vercel.json). Stores today's USD to KES rate. Same CRON_SECRET rule as cron-commissions.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) return send(res, 503, { error: 'CRON_SECRET is not set.' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!sameSecret(given, secret)) return send(res, 401, { error: 'Not allowed.' });
    try {
        const r = await FX.refreshRate(getDb());
        if (!r.ok) console.error('cron-fx:', r.reason);
        return send(res, r.ok ? 200 : 502, r);
    } catch (err) {
        console.error('cron-fx error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
