// The operator's wallet: confirmed earnings, minus withdrawals, minus what they spent on domains.
//
// Money rules:
//   - Spending checks the balance and writes the debit in ONE statement, then re-checks that the balance is not below zero.
//     If it is (a withdrawal slipped in at the same moment), the debit is undone and nothing is sold.
//   - One wallet payment can be in flight per operator (unique index), and one debit per order.
//   - A debit becomes 'spent' only when the domain is registered. If the order fails for good, it becomes 'refunded'
//     and the money is back in the balance. A debit that is unsure ('check_needed') stays 'held' until a person decides.

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cents = v => Math.round(num(v) * 100) / 100;

// Confirmed earnings - withdrawals (requested or paid) - wallet debits (held or spent), floored to the cent. Never negative.
async function available(sql, ownerId) {
    const r = (await sql`
        SELECT (COALESCE((SELECT SUM(c.owner_usd) FROM commission_daily c JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM') WHERE c.owner_id = ${ownerId}::int), 0)
              - COALESCE((SELECT SUM(p.amount_usd) FROM payout_requests p WHERE p.owner_id = ${ownerId}::int AND p.status IN ('requested', 'paid')), 0)
              - COALESCE((SELECT SUM(d.amount_usd) FROM wallet_debits d WHERE d.owner_id = ${ownerId}::int AND d.status IN ('held', 'spent')), 0)) AS bal`)[0];
    return { raw: num(r.bal), available: Math.max(0, Math.floor(num(r.bal) * 100 + 1e-6) / 100) };
}

// -> { ok: true } | { ok: false, reason: 'insufficient' | 'busy' }
async function hold(sql, ownerId, orderId, amountUsd) {
    const amount = cents(amountUsd);
    if (!(amount > 0)) return { ok: false, reason: 'insufficient' };
    let rows;
    try {
        rows = await sql`
            INSERT INTO wallet_debits (owner_id, order_id, amount_usd)
            SELECT ${ownerId}::int, ${orderId}::int, ${amount}::numeric
            WHERE ${amount}::numeric <= floor((
                  COALESCE((SELECT SUM(c.owner_usd) FROM commission_daily c JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM') WHERE c.owner_id = ${ownerId}::int), 0)
                - COALESCE((SELECT SUM(p.amount_usd) FROM payout_requests p WHERE p.owner_id = ${ownerId}::int AND p.status IN ('requested', 'paid')), 0)
                - COALESCE((SELECT SUM(d.amount_usd) FROM wallet_debits d WHERE d.owner_id = ${ownerId}::int AND d.status IN ('held', 'spent')), 0)) * 100 + 0.000001) / 100
            RETURNING id`;
    } catch (err) {
        if (err && err.code === '23505') return { ok: false, reason: 'busy' };
        throw err;
    }
    if (!rows.length) return { ok: false, reason: 'insufficient' };
    if ((await available(sql, ownerId)).raw < -0.000001) {          // someone withdrew at the same moment
        await sql`DELETE FROM wallet_debits WHERE id = ${rows[0].id} AND status = 'held'`;
        return { ok: false, reason: 'insufficient' };
    }
    return { ok: true };
}

// Called after every step that can end an order. Safe to call any number of times.
async function settleOrder(sql, orderId) {
    const o = (await sql`SELECT id, status, pay_method FROM domain_orders WHERE id = ${orderId} LIMIT 1`)[0];
    if (!o || o.pay_method !== 'wallet') return null;
    if (o.status === 'completed') {
        await sql`UPDATE wallet_debits SET status = 'spent', updated_at = now() WHERE order_id = ${orderId} AND status = 'held'`;
    } else if (['refund_due', 'cancelled', 'expired'].includes(o.status)) {
        // Wallet money goes straight back. No one has to send a refund by hand.
        await sql`UPDATE wallet_debits SET status = 'refunded', updated_at = now() WHERE order_id = ${orderId} AND status = 'held'`;
        await sql`UPDATE domain_orders SET status = 'refunded', refund_reference = 'Returned to wallet', updated_at = now() WHERE id = ${orderId} AND status = 'refund_due'`;
    } else if (o.status === 'refunded') {
        await sql`UPDATE wallet_debits SET status = 'refunded', updated_at = now() WHERE order_id = ${orderId} AND status = 'held'`;
    }
    return o.status;
}

// One list of everything that moved the balance, newest first. Amounts: + in, - out.
async function history(sql, ownerId) {
    const [months, payouts, debits] = await Promise.all([
        sql`SELECT m.month, m.confirmed_at AS at, SUM(c.owner_usd) AS usd
            FROM commission_daily c JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM')
            WHERE c.owner_id = ${ownerId} GROUP BY m.month, m.confirmed_at ORDER BY m.confirmed_at DESC LIMIT 24`,
        sql`SELECT id, amount_usd, method, status, created_at AS at FROM payout_requests
            WHERE owner_id = ${ownerId} AND status IN ('requested', 'paid') ORDER BY id DESC LIMIT 50`,
        sql`SELECT d.id, d.amount_usd, d.status, d.created_at AS at, d.updated_at, o.domain, o.kind
            FROM wallet_debits d JOIN domain_orders o ON o.id = d.order_id
            WHERE d.owner_id = ${ownerId} ORDER BY d.id DESC LIMIT 50`,
    ]);
    const list = [];
    months.forEach(m => list.push({ at: m.at, type: 'earnings', label: `Earnings for ${m.month}`, amount: cents(m.usd), status: 'done' }));
    payouts.forEach(p => list.push({ at: p.at, type: 'withdrawal', label: `Withdrawal to ${p.method === 'mpesa' ? 'M-Pesa' : 'USDT'}`, amount: -cents(p.amount_usd), status: p.status === 'paid' ? 'done' : 'waiting' }));
    debits.forEach(d => {
        const what = d.kind === 'renewal' ? `Renewal of ${d.domain}` : `Domain ${d.domain}`;
        list.push({ at: d.at, type: 'domain', label: what, amount: -cents(d.amount_usd), status: d.status === 'spent' ? 'done' : d.status === 'held' ? 'waiting' : 'returned' });
        if (d.status === 'refunded') list.push({ at: d.updated_at, type: 'refund', label: `Returned: ${what}`, amount: cents(d.amount_usd), status: 'done' });
    });
    list.sort((a, b) => new Date(b.at) - new Date(a.at));
    return list.slice(0, 60);
}

module.exports = { available, hold, settleOrder, history };
