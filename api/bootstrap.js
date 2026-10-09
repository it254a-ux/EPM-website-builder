const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const C = require('./_lib/commissions');
const L = require('./_lib/library');
const mySite = require('./my-site');

const send = (res, code, body) => res.status(code).json(body);

// Everything the operator dashboard shows, in ONE request, read at the same time.
// The page keeps it in memory, so moving between pages and tabs never waits on the network.
//   GET /api/bootstrap -> { owner, google, state: {site,dns,free_root,events}, commissions, library }
//   Signed out         -> { owner: null, google }
//   Admin account      -> { owner, google }   (the admin panel loads its own data)
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    try {
        const sql = getDb();
        const google = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
        const me = await A.getSession(sql, req);
        if (!me || me.role !== 'operator') return send(res, 200, { owner: me, google });
        const [state, commissions, library] = await Promise.all([
            mySite.findOwn(sql, me.id).then(row => mySite.siteState(sql, row)),
            C.operatorView(sql, me.id),
            L.operatorView(sql, me.id),
        ]);
        return send(res, 200, { owner: me, google, state, commissions, library });
    } catch (err) {
        console.error('bootstrap error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
};
