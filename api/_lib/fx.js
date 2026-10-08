// The daily USD to KES exchange rate.
//   - A daily job (api/cron-fx.js) asks a free, key-less source and stores the answer in fx_rates.
//   - currentRate() gives the newest stored rate if it is under 48 hours old.
//     If not, it falls back to KES_PER_USD (a number you type in Vercel). With neither, it answers null and no shilling price is shown.
//   - A rate that looks wrong (outside 50..500, or more than 15% away from the last one) is NOT stored; the old one stays.
//
// Source: https://open.er-api.com/v6/latest/USD (ExchangeRate-API open access: no key, updates once a day, caching allowed).
// Their terms ask for attribution, so the Buy page shows "Rates By Exchange Rate API" with a link.
// Settings (optional): FX_API_URL to use another source that answers the same way. KES_PER_USD as the fallback.
// UNTESTED against the live source until the first real run.

const PAIR = 'USD_KES';
const DEFAULT_URL = 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT_MS = 8000;
const FRESH_HOURS = 48;
const MIN_RATE = 50, MAX_RATE = 500, MAX_JUMP = 0.15;

const env = k => String(process.env[k] || '').trim();

async function defaultTransport(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        let body = null;
        try { body = await r.json(); } catch (e) { /* not JSON */ }
        return { status: r.status, body };
    } finally { clearTimeout(timer); }
}
let transport = defaultTransport;
const setTransport = fn => { transport = fn || defaultTransport; };

// Pulls the shilling rate out of the source's answer, or null if the answer is not usable.
function parseRate(res) {
    if (!res || res.status !== 200 || !res.body) return null;
    const b = res.body;
    if (b.result && b.result !== 'success') return null;
    const v = Number(b.rates && b.rates.KES);
    return Number.isFinite(v) && v > 0 ? v : null;
}

const latest = async sql => (await sql`SELECT rate, source, fetched_at FROM fx_rates WHERE pair = ${PAIR} ORDER BY id DESC LIMIT 1`)[0] || null;

// Fetch, check, store. Never throws. Returns { ok:true, rate } or { ok:false, reason }.
async function refreshRate(sql) {
    const url = env('FX_API_URL') || DEFAULT_URL;
    let res;
    try { res = await transport(url); }
    catch (err) { return { ok: false, reason: 'Could not reach the exchange-rate source.' }; }
    const rate = parseRate(res);
    if (rate === null) return { ok: false, reason: 'The exchange-rate source gave an answer I cannot use.' };
    if (rate < MIN_RATE || rate > MAX_RATE) return { ok: false, reason: `The rate ${rate} looks wrong, so it was not used.` };

    const prev = await latest(sql);
    if (prev) {
        const ageDays = (Date.now() - new Date(prev.fetched_at).getTime()) / 86400000;
        const jump = Math.abs(rate - Number(prev.rate)) / Number(prev.rate);
        if (ageDays < 7 && jump > MAX_JUMP) return { ok: false, reason: `The rate ${rate} is more than 15% away from the last one (${Number(prev.rate)}), so it was not used. Check it.` };
    }
    await sql`INSERT INTO fx_rates (pair, rate, source) VALUES (${PAIR}, ${rate}, ${'open.er-api.com'})`;
    return { ok: true, rate };
}

// { rate, source: 'live' | 'manual', fetchedAt } or null.
async function currentRate(sql) {
    const row = await latest(sql);
    if (row && (Date.now() - new Date(row.fetched_at).getTime()) <= FRESH_HOURS * 3600000) {
        return { rate: Number(row.rate), source: 'live', fetchedAt: row.fetched_at };
    }
    const manual = Number(env('KES_PER_USD'));
    if (Number.isFinite(manual) && manual > 0) return { rate: manual, source: 'manual', fetchedAt: null };
    return null;
}

module.exports = { refreshRate, currentRate, parseRate, setTransport, defaultTransport, PAIR, FRESH_HOURS };
