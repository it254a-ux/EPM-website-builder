const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const C = require('./_lib/commissions');

const send = (res, code, body) => res.status(code).json(body);

// An operator's own earnings and withdrawals. Never returns markup, volume or either commission share.
//   GET  /api/commissions                                   -> summary, days, months, requests
//   POST /api/commissions { action: 'withdraw', amount, method: 'mpesa' | 'usdt', destination, network? }
//   POST /api/commissions { action: 'cancel', id }          -> cancels a request that is still waiting
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'operator') return send(res, 403, { error: 'Use the admin panel for admin accounts.' });

        if (req.method === 'GET') return send(res, 200, await C.operatorView(sql, me.id));

        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
        const body = A.readBody(req);

        if (body.action === 'withdraw') {
            if ((await A.hit(sql, `withdraw:owner:${me.id}`, 3600)) > 12) return send(res, 429, { error: 'Too many attempts. Please try again later.' });
            const checked = C.validateWithdrawal(body);
            if (!checked.value) return send(res, 400, { error: checked.error, fields: { [checked.field]: checked.error } });
            const v = checked.value;
            let id;
            try {
                id = await C.createWithdrawal(sql, me.id, v);
            } catch (err) {
                if (err && err.code === '23505') return send(res, 409, { error: 'You already have a withdrawal waiting. Cancel it, or wait until it is paid.' });
                throw err;
            }
            if (!id) {
                const b = await C.balances(sql, me.id);
                return send(res, 400, {
                    error: `You can withdraw up to $${b.available.toFixed(2)} right now.`,
                    fields: { amount: `You can withdraw up to $${b.available.toFixed(2)} right now.` },
                });
            }
            await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${me.id}, 'payout_requested', ${String(id)}, ${JSON.stringify({ amount_usd: v.amount, method: v.method, network: v.network })}::jsonb)`;
            return send(res, 201, await C.operatorView(sql, me.id));
        }

        if (body.action === 'cancel') {
            const r = await sql`
                UPDATE payout_requests SET status = 'cancelled', decided_at = now()
                WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} AND status = 'requested' RETURNING id`;
            if (!r.length) return send(res, 404, { error: 'That request is not waiting any more.' });
            await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${me.id}, 'payout_cancelled', ${String(r[0].id)}, '{}'::jsonb)`;
            return send(res, 200, await C.operatorView(sql, me.id));
        }

        return send(res, 400, { error: 'Unknown action' });
    } catch (err) {
        console.error('commissions error:', err);
        return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
};
