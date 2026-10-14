const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const M = require('./_lib/mpesa');
const DO = require('./_lib/domain-orders');
const P = require('./_lib/payouts');

const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

// Safaricom reports here when a customer finishes (or cancels) a payment prompt, and when a payout to an operator finishes.
// The address carries MPESA_CALLBACK_SECRET (?k=...), so only Safaricom, who was given the address, can reach the logic.
// Even then a "success" is only noted; the order becomes paid only after we ask Safaricom to confirm it (see domain-orders.js).
// Named "pay-callback" on purpose: Safaricom rejects some addresses containing brand words.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = M.settings().callbackSecret;
    if (!secret) return res.status(503).json({ error: 'Not set up.' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!sameSecret(req.query && req.query.k, secret)) return res.status(401).json({ error: 'Not allowed.' });

    // Payouts to operators report here too (the address has ?p=<request number>&t=result|timeout). One file, because Vercel's free plan allows only 12 functions.
    if (req.query && (req.query.p !== undefined || (req.body && req.body.Result))) {
        const ok = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
        const id = Number(req.query.p);
        if (!Number.isInteger(id) || id <= 0) return ok();
        try { await P.applyResult(getDb(), id, M.parseB2cResult(req.body), req.query.t === 'timeout' ? 'timeout' : 'result'); }
        catch (err) { console.error('payout callback error:', err && err.message); }
        return ok();
    }

    const cb = M.parseCallback(req.body);
    // Always answer Safaricom with success so it does not keep retrying, even for things we ignore.
    const ok = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    if (!cb) return ok();
    try {
        const sql = getDb();
        const r = await DO.applyCallback(sql, cb);
        if (r && r.status === 'paid' && r.id) await DO.fulfil(sql, r.id);
    } catch (err) {
        console.error('pay-callback error:', err && err.message);
    }
    return ok();
};
