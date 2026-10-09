const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const FX = require('./_lib/fx');
const DO = require('./_lib/domain-orders');

const send = (res, code, body) => res.status(code).json(body);
const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

// Called once a day by Vercel Cron (see vercel.json). Stores today's USD to KES rate, and finishes stuck domain orders. Same CRON_SECRET rule as cron-commissions.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) return send(res, 503, { error: 'CRON_SECRET is not set.' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!sameSecret(given, secret)) return send(res, 401, { error: 'Not allowed.' });
    try {
        const sql = getDb();
        const r = await FX.refreshRate(sql);
        if (!r.ok) console.error('cron-fx:', r.reason);
        // The same daily visit also finishes any paid domain order that got stuck (see domain-orders.js).
        let sweep = null;
        try { sweep = await DO.sweep(sql); } catch (err) { console.error('cron-fx sweep:', err && err.message); }
        return send(res, r.ok ? 200 : 502, sweep ? { ...r, sweep } : r);
    } catch (err) {
        console.error('cron-fx error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
