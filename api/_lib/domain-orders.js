// Domain orders: creating them, and deciding when one counts as PAID.
// An order only becomes "paid" when Safaricom itself confirms it (a payment query), never on a message alone.
// Every status change is one SQL statement that names the status it expects, so repeated or racing messages cannot do it twice.

const M = require('./mpesa');
const R = require('./vercel-registrar');
const VD = require('./vercel-domains');
const { logEvent } = require('./events');
const { syncAppToDeriv, reasonOf } = require('./site-app');
const S = require('./site-settings');

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
        return { handled: true, id: found.id, status: 'cancelled' };
    }
    // Remember what they say they paid (and the receipt), but do not mark it paid until Safaricom confirms.
    try {
        await sql`UPDATE domain_orders SET mpesa_receipt = COALESCE(mpesa_receipt, ${cb.receipt}), paid_kes = COALESCE(paid_kes, ${cb.amount === null ? null : Math.round(cb.amount)}::int), updated_at = now() - interval '1 minute' WHERE id = ${found.id}`;
    } catch (err) {
        if (!(err && err.code === '23505')) throw err;
        await sql`UPDATE domain_orders SET status = 'refund_due', failure_reason = 'That M-Pesa receipt was already used on another order.', updated_at = now() WHERE id = ${found.id} AND status = 'awaiting_payment'`;
        return { handled: true, id: found.id, status: 'refund_due' };
    }
    const q = await M.stkQuery(cb.checkoutId);
    if (q.paid === true) {
        const o = await markPaid(sql, found.id, { receipt: cb.receipt, paidKes: cb.amount === null ? null : Math.round(cb.amount) });
        return { handled: true, id: found.id, status: o ? o.status : found.status };
    }
    if (q.paid === false) {
        await sql`UPDATE domain_orders SET status = 'cancelled', failure_reason = ${q.desc || 'Payment not completed'}, updated_at = now() WHERE id = ${found.id} AND status = 'awaiting_payment'`;
        return { handled: true, id: found.id, status: 'cancelled' };
    }
    return { handled: true, id: found.id, status: 'awaiting_payment' };      // Safaricom could not say yet: the next check will settle it
}

// ---------- after payment: buy (or renew) the domain, then connect the site ----------
const note = (sql, id, text) => sql`UPDATE domain_orders SET failure_reason = ${String(text).slice(0, 300)}, updated_at = now() WHERE id = ${id}`;

// The domain is ours now. Point the site at it. Every step after the purchase is best-effort: money and domain are already real,
// so a failure here is written on the order for the admin instead of undoing anything.
async function activatePurchase(sql, o) {
    const notes = [];
    const site = (await sql`SELECT * FROM sites WHERE id = ${o.site_id}`)[0];
    if (!site) return ['The site no longer exists.'];
    try {
        await sql`UPDATE sites SET domain = ${o.domain}, plan = 'custom', status = 'active', custom_domain_requested = NULL, domain_bought_here = true,
                                   domain_expires_at = now() + interval '1 year', domain_paused_at = NULL, updated_at = now() WHERE id = ${o.site_id}`;
    } catch (err) { return ['Registered, but the site could not be switched: ' + reasonOf(err)]; }
    const share = site.commission_rate_override !== null ? Number(site.commission_rate_override) : S.PLAN_SHARE.custom;
    try { await sql`INSERT INTO site_rate_history (site_id, plan, platform_share) VALUES (${o.site_id}, 'custom', ${share})`; } catch (err) { notes.push('Rate history not written.'); }
    await logEvent(sql, o.site_id, 'domain_bought', { domain: o.domain });
    if (site.app_id && site.app_source === 'api') {
        try { await syncAppToDeriv(sql, site, { plan: 'custom', domain: o.domain }); await logEvent(sql, o.site_id, 'app_redirect_updated', { domain: o.domain }); }
        catch (err) { notes.push(`The Deriv app redirect was not updated (${reasonOf(err)}).`); }
    }
    const v = await VD.addDomain(o.domain);
    if (v.status !== 'off') await logEvent(sql, o.site_id, 'domain_vercel_' + v.status, { domain: o.domain });
    if (!['added', 'already_added'].includes(v.status)) notes.push(`Not yet on the Vercel project: ${v.message}`);
    return notes;
}

// Claims a paid order and does the registrar call. Safe to call from anywhere, any number of times: only one caller wins the claim.
async function fulfil(sql, id) {
    const o = (await sql`UPDATE domain_orders SET status = 'buying', attempts = attempts + 1, updated_at = now() WHERE id = ${id} AND status = 'paid' RETURNING *`)[0];
    if (!o) return null;
    const args = { domain: o.domain, years: o.years, expectedPriceUsd: o.cost_usd_cents / 100 };
    const r = o.kind === 'renewal' ? await R.renewDomain(args) : await R.buyDomain({ ...args, contact: o.contact });
    if (!r.ok) {
        if (r.kind === 'definite') await sql`UPDATE domain_orders SET status = 'refund_due', failure_reason = ${r.message}, updated_at = now() WHERE id = ${id}`;
        else if (r.kind === 'retry' && o.attempts < 5) await sql`UPDATE domain_orders SET status = 'paid', failure_reason = ${r.message}, updated_at = now() WHERE id = ${id}`;
        else await sql`UPDATE domain_orders SET status = 'check_needed', failure_reason = ${r.message}, updated_at = now() WHERE id = ${id}`;
        return get(sql, id);
    }
    await sql`UPDATE domain_orders SET status = 'completed', vercel_order_id = ${r.orderId}, completed_at = now(), failure_reason = NULL, updated_at = now() WHERE id = ${id}`;
    const notes = o.kind === 'renewal' ? await applyRenewal(sql, o) : await activatePurchase(sql, o);
    if (notes.length) await note(sql, id, notes.join(' '));
    return get(sql, id);
}

// A renewal went through: push the expiry out a year, and switch the site back on if we paused it.
async function applyRenewal(sql, o) {
    await sql`UPDATE sites SET domain_expires_at = COALESCE(domain_expires_at, now()) + interval '1 year', updated_at = now() WHERE id = ${o.site_id}`;
    const back = await sql`UPDATE sites SET status = 'active', domain_paused_at = NULL, updated_at = now() WHERE id = ${o.site_id} AND domain_paused_at IS NOT NULL RETURNING id`;
    await logEvent(sql, o.site_id, back.length ? 'domain_renewed_resumed' : 'domain_renewed', { domain: o.domain });
    return [];
}

// A domain we sold has passed its expiry and nobody renewed it: pause the site. Nothing is charged to you.
// Pausing uses the normal "suspended" status, which the trading site already treats as "not live". Renewing switches it back on.
async function pauseExpired(sql) {
    const paused = await sql`UPDATE sites SET status = 'suspended', domain_paused_at = now(), updated_at = now()
                             WHERE domain_bought_here = true AND domain_expires_at < now() AND domain_paused_at IS NULL AND status = 'active'
                             RETURNING id, domain`;
    for (const p of paused) await logEvent(sql, p.id, 'domain_expired_paused', { domain: p.domain });
    return paused.length;
}

// Anything paid but not finished (callback missed, function stopped): called by the daily job and by the operator's polling.
async function sweep(sql) {
    const stuck = await sql`UPDATE domain_orders SET status = 'check_needed', failure_reason = 'The registration stopped part-way. Check Vercel before doing anything.', updated_at = now()
                            WHERE status = 'buying' AND updated_at < now() - interval '5 minutes' RETURNING id`;
    const paid = await sql`SELECT id FROM domain_orders WHERE status = 'paid' ORDER BY id LIMIT 20`;
    for (const p of paid) await fulfil(sql, p.id);
    const pausedSites = await pauseExpired(sql);
    return { stuck: stuck.length, retried: paid.length, paused: pausedSites };
}

module.exports = { PAY_WINDOW_MINUTES, fulfil, sweep, pauseExpired, activatePurchase, applyRenewal, MESSAGES, view, get, expireStale, markPaid, confirmWaiting, applyCallback };
