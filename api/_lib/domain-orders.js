// Domain orders: creating them, and deciding when one counts as PAID.
// An order only becomes "paid" when Safaricom itself confirms it (a payment query), never on a message alone.
// Every status change is one SQL statement that names the status it expects, so repeated or racing messages cannot do it twice.

const M = require('./mpesa');

const PAY_WINDOW_MINUTES = 10;

// What the operator is told, in plain words.
const MESSAGES = {
    awaiting_payment: 'Check your phone and enter your M-Pesa PIN to pay.',
    cancelled: 'The payment was not completed. Nothing was charged. You can try again.',
    expired: 'The payment window closed. If money left your phone, contact support with your M-Pesa message.',
    paid: 'Payment received. We are registering your domain now.',
    buying: 'Payment received. We are registering your domain now.',
    completed: 'Done. Your domain is registered and connected to your site.',
    check_needed: 'Payment received. We are checking your registration and will confirm shortly.',
    refund_due: 'We could not complete this order. Your payment will be refunded to your M-Pesa.',
    refunded: 'This order was refunded to your M-Pesa.',
};

// What an operator may see about an order. Never the registrar's price or your profit.
const view = o => ({
    id: o.id, kind: o.kind, domain: o.domain, status: o.status, message: MESSAGES[o.status] || '',
    price_usd: o.price_usd_cents / 100, price_kes: o.price_kes,
    renewal_usd: o.renewal_usd_cents ? o.renewal_usd_cents / 100 : null,
    receipt: o.mpesa_receipt || null, created_at: o.created_at, completed_at: o.completed_at || null,
});

const get = async (sql, id) => (await sql`SELECT * FROM domain_orders WHERE id = ${id} LIMIT 1`)[0] || null;

// Release names whose payment window has passed, so someone else can buy them.
const expireStale = sql => sql`UPDATE domain_orders SET status = 'expired', updated_at = now() WHERE status = 'awaiting_payment' AND expires_at < now()`;

// awaiting_payment (or a late payment on a cancelled/expired order) -> paid. Returns the order, or null if it was not in a state to be paid.
// A payment of the wrong amount goes to refund_due instead. If someone else grabbed the name meanwhile, this one also goes to refund_due.
async function markPaid(sql, id, { receipt, paidKes } = {}) {
    const run = () => sql`
        UPDATE domain_orders SET
            status = CASE WHEN COALESCE(${paidKes ?? null}::int, paid_kes) IS NOT NULL AND COALESCE(${paidKes ?? null}::int, paid_kes) <> price_kes THEN 'refund_due' ELSE 'paid' END,
            failure_reason = CASE WHEN COALESCE(${paidKes ?? null}::int, paid_kes) IS NOT NULL AND COALESCE(${paidKes ?? null}::int, paid_kes) <> price_kes
                                  THEN 'The amount paid did not match the price.' ELSE failure_reason END,
            mpesa_receipt = COALESCE(mpesa_receipt, ${receipt || null}),
            paid_kes = COALESCE(paid_kes, ${paidKes ?? null}::int),
            paid_at = now(), updated_at = now()
        WHERE id = ${id} AND status IN ('awaiting_payment', 'cancelled', 'expired')
        RETURNING *`;
    try {
        return (await run())[0] || null;
    } catch (err) {
        if (err && err.code === '23505') {
            // The receipt is already used by another order, or another buyer holds this name now.
            const r = await sql`UPDATE domain_orders SET status = 'refund_due', failure_reason = 'The name was taken by another order while payment was being made.', paid_at = now(), updated_at = now()
                                WHERE id = ${id} AND status IN ('awaiting_payment', 'cancelled', 'expired') RETURNING *`;
            return r[0] || null;
        }
        throw err;
    }
}

// Ask Safaricom about an order that is waiting. At most one question per 10 seconds per order.
async function confirmWaiting(sql, id) {
    const claim = await sql`UPDATE domain_orders SET updated_at = now()
                            WHERE id = ${id} AND status = 'awaiting_payment' AND mpesa_checkout_id IS NOT NULL AND updated_at < now() - interval '10 seconds'
                            RETURNING *`;
    if (!claim[0]) return null;
    const q = await M.stkQuery(claim[0].mpesa_checkout_id);
    if (q.paid === true) return markPaid(sql, id, { receipt: claim[0].mpesa_receipt, paidKes: claim[0].paid_kes });
    if (q.paid === false) {
        await sql`UPDATE domain_orders SET status = 'cancelled', failure_reason = ${q.desc || 'Payment not completed'}, updated_at = now() WHERE id = ${id} AND status = 'awaiting_payment'`;
    }
    return null;
}

// Safaricom reported the result of a prompt. Records it, and asks Safaricom to confirm before trusting a success.
async function applyCallback(sql, cb) {
    const found = (await sql`SELECT * FROM domain_orders WHERE mpesa_checkout_id = ${cb.checkoutId} LIMIT 1`)[0];
    if (!found) return { handled: false };
    if (cb.resultCode !== 0) {
        await sql`UPDATE domain_orders SET status = 'cancelled', failure_reason = ${cb.desc || 'Payment not completed'}, updated_at = now() WHERE id = ${found.id} AND status = 'awaiting_payment'`;
        return { handled: true, status: 'cancelled' };
    }
    // Remember what they say they paid (and the receipt), but do not mark it paid until Safaricom confirms.
    try {
        await sql`UPDATE domain_orders SET mpesa_receipt = COALESCE(mpesa_receipt, ${cb.receipt}), paid_kes = COALESCE(paid_kes, ${cb.amount === null ? null : Math.round(cb.amount)}::int), updated_at = now() - interval '1 minute' WHERE id = ${found.id}`;
    } catch (err) {
        if (!(err && err.code === '23505')) throw err;
        await sql`UPDATE domain_orders SET status = 'refund_due', failure_reason = 'That M-Pesa receipt was already used on another order.', updated_at = now() WHERE id = ${found.id} AND status = 'awaiting_payment'`;
        return { handled: true, status: 'refund_due' };
    }
    const q = await M.stkQuery(cb.checkoutId);
    if (q.paid === true) {
        const o = await markPaid(sql, found.id, { receipt: cb.receipt, paidKes: cb.amount === null ? null : Math.round(cb.amount) });
        return { handled: true, status: o ? o.status : found.status };
    }
    if (q.paid === false) {
        await sql`UPDATE domain_orders SET status = 'cancelled', failure_reason = ${q.desc || 'Payment not completed'}, updated_at = now() WHERE id = ${found.id} AND status = 'awaiting_payment'`;
        return { handled: true, status: 'cancelled' };
    }
    return { handled: true, status: 'awaiting_payment' };      // Safaricom could not say yet: the next check will settle it
}

module.exports = { PAY_WINDOW_MINUTES, MESSAGES, view, get, expireStale, markPaid, confirmWaiting, applyCallback };
