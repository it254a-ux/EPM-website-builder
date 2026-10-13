const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const M = require('./_lib/mpesa');
const P = require('./_lib/payouts');

const sameSecret = (given, expected) => {
    const a = Buffer.from(String(given || '')), b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

// Safaricom reports here when a payout to an operator finishes (t=result) or runs out of time (t=timeout).
// The address carries MPESA_CALLBACK_SECRET (?k=) and our request number (?p=). Named "pay-b2c" on purpose: Safaricom rejects some brand words in addresses.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = M.settings().callbackSecret;
    if (!secret) return res.status(503).json({ error: 'Not set up.' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const q = req.query || {};
    if (!sameSecret(q.k, secret)) return res.status(401).json({ error: 'Not allowed.' });
    const ok = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });      // always answer success so Safaricom stops retrying
    const id = Number(q.p);
    if (!Number.isInteger(id) || id <= 0) return ok();
    try {
        await P.applyResult(getDb(), id, M.parseB2cResult(req.body), q.t === 'timeout' ? 'timeout' : 'result');
    } catch (err) {
        console.error('pay-b2c error:', err && err.message);
    }
    return ok();
};
