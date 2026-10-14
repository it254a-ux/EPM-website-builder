// Paying an operator's withdrawal request through the system (M-Pesa business payment).
//
// While the money is in flight the request stays status 'requested' (so every balance rule keeps working) and send_state is 'sending'.
//   send       one UPDATE claims the request (only one click can win), then Safaricom is asked to send.
//   result     Safaricom reports back to /api/pay-callback. Success -> status 'paid' with its receipt as the reference. Failure -> back to pending, with the reason.
//   unclear    no answer from Safaricom: it stays 'sending' for a person to check the M-Pesa statement, then "Release" it.
// Manual paying (outside the system) is unchanged: "Mark paid" with a reference. It is blocked while a send is in flight.

const M = require('./mpesa');
const FX = require('./fx');

const RELEASE_AFTER_MINUTES = 10;

const callbackUrls = (host, id) => {
    const base = `https://${host}/api/pay-callback?k=${encodeURIComponent(M.settings().callbackSecret)}&p=${id}`;
    return { resultUrl: base + '&t=result', timeoutUrl: base + '&t=timeout' };
};

// Returns { ok:true, request } or { ok:false, code, error }.
async function sendMpesa(sql, id, host) {
    if (!M.b2cConfigured()) return { ok: false, code: 409, error: `Payouts through M-Pesa are not set up yet. Add in Vercel: ${M.b2cMissing().join(', ')}.` };
    const rate = await FX.currentRate(sql);
    if (!rate) return { ok: false, code: 503, error: 'No exchange rate is available right now, so the shilling amount cannot be worked out.' };

    // Claim it. Only a request that is waiting, not already being sent, and for M-Pesa.
    const claimed = (await sql`
        UPDATE payout_requests SET send_state = 'sending', sent_at = now(), fx_rate = ${rate.rate}, sent_kes = floor(amount_usd * ${rate.rate}), send_error = NULL
        WHERE id = ${id} AND status = 'requested' AND method = 'mpesa' AND send_state IS NULL
        RETURNING *`)[0];
    if (!claimed) return { ok: false, code: 409, error: 'This request is not waiting for an M-Pesa payment (it may already be sending, paid or rejected).' };
    if (claimed.sent_kes < 10) {
        await sql`UPDATE payout_requests SET send_state = NULL, send_error = 'The amount is under KES 10, which M-Pesa will not send.' WHERE id = ${id}`;
        return { ok: false, code: 400, error: 'The amount is under KES 10, which M-Pesa will not send.' };
    }

    const { resultUrl, timeoutUrl } = callbackUrls(host, id);
    const r = await M.b2cPay({ phone: claimed.destination, amountKes: claimed.sent_kes, remarks: `EPM payout ${id}`, resultUrl, timeoutUrl });
    if (r.ok) {
        await sql`UPDATE payout_requests SET b2c_conversation = ${r.conversationId} WHERE id = ${id}`;
    } else if (r.kind === 'rejected') {
        await sql`UPDATE payout_requests SET send_state = NULL, send_error = ${r.error} WHERE id = ${id}`;
    } else {
        await sql`UPDATE payout_requests SET send_error = ${r.error} WHERE id = ${id}`;     // stays 'sending': a person must check
    }
    const now = (await sql`SELECT * FROM payout_requests WHERE id = ${id}`)[0];
    return r.ok || r.kind === 'unclear' ? { ok: true, request: now, unclear: !r.ok } : { ok: false, code: 502, error: r.error };
}

// Safaricom's report. Always safe to call twice. Returns what happened, for logging.
async function applyResult(sql, id, result, kind) {
    const row = (await sql`SELECT * FROM payout_requests WHERE id = ${id}`)[0];
    if (!row) return 'unknown';
    if (kind === 'timeout' || !result) {
        await sql`UPDATE payout_requests SET send_error = 'M-Pesa did not finish in time. Check your M-Pesa statement before trying again.' WHERE id = ${id} AND send_state = 'sending'`;
        return 'timeout';
    }
    if (result.code === 0) {
        if (result.amount !== null && row.sent_kes !== null && Math.round(result.amount) !== row.sent_kes) {
            await sql`UPDATE payout_requests SET send_error = ${`M-Pesa says KES ${result.amount} was sent but we asked for KES ${row.sent_kes}. Check the M-Pesa statement.`} WHERE id = ${id} AND send_state = 'sending'`;
            return 'amount_mismatch';
        }
        const paid = await sql`UPDATE payout_requests SET status = 'paid', reference = ${result.receipt || ('B2C-' + id)}, decided_at = now(), send_state = NULL, send_error = NULL
                               WHERE id = ${id} AND status = 'requested' AND send_state = 'sending' RETURNING id`;
        if (paid.length) return 'paid';
        // Money went out but the request is no longer waiting (for example you marked it paid by hand after releasing it).
        await sql`UPDATE payout_requests SET send_error = ${`DUPLICATE: M-Pesa also sent KES ${row.sent_kes} (receipt ${result.receipt || 'unknown'}). Check you did not pay twice.`} WHERE id = ${id}`;
        return 'duplicate';
    }
    await sql`UPDATE payout_requests SET send_state = NULL, send_error = ${`M-Pesa could not send it: ${result.desc || 'failed'}`} WHERE id = ${id} AND status = 'requested' AND send_state = 'sending'`;
    return 'failed';
}

// After checking the M-Pesa statement and finding nothing was sent, put a stuck request back to pending.
async function release(sql, id) {
    const r = await sql`UPDATE payout_requests SET send_state = NULL, send_error = 'Released after a check. Nothing was confirmed as sent.'
                        WHERE id = ${id} AND status = 'requested' AND send_state = 'sending' AND sent_at < now() - (${RELEASE_AFTER_MINUTES} || ' minutes')::interval RETURNING id`;
    return r.length === 1;
}

module.exports = { sendMpesa, applyResult, release, RELEASE_AFTER_MINUTES };
