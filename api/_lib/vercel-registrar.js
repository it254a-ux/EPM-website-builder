// Searches Vercel's domain registrar for availability and prices.
//   POST https://api.vercel.com/v1/registrar/domains/search   { domains: [...] }   (up to 200 names; Vercel's docs say no sign-in is needed)
//   An available domain comes back as { domain, available, years, price, renewalPrice, premium }; a taken one as { domain, available }.
// We do NOT send your Vercel token here, so a wrong token can never break searching.
// UNTESTED against live Vercel: the first real search is the real test. Prices are in US dollars.
//
// This only reads. Buying and renewing are separate (later) and will use DOMAINS_VERCEL_TOKEN.

const env = k => String(process.env[k] || '').trim();
const BASE = () => (env('DOMAINS_VERCEL_API') || 'https://api.vercel.com').replace(/\/+$/, '');
const TIMEOUT_MS = 8000;

async function defaultTransport(url, options) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...options, signal: ctl.signal });
        let body = null;
        try { body = await r.json(); } catch (e) { /* not JSON */ }
        return { status: r.status, body };
    } finally { clearTimeout(timer); }
}
let transport = defaultTransport;
const setTransport = fn => { transport = fn || defaultTransport; };

const toCents = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const isTrue = v => v === true || v === 'true';

// Returns { ok:true, results:[{ domain, available, years, costCents, renewalCents, premium }] } or { ok:false, error }.
// costCents / renewalCents are YOUR cost at Vercel. They must never be shown to operators.
async function searchDomains(domains) {
    const names = [...new Set((domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    if (!names.length) return { ok: true, results: [] };
    let res;
    try {
        res = await transport(`${BASE()}/v1/registrar/domains/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domains: names }),
        });
    } catch (err) {
        return { ok: false, error: 'Could not reach the domain registrar.' };
    }
    if (!res || res.status !== 200 || !res.body || !Array.isArray(res.body.results)) {
        return { ok: false, error: `The domain registrar answered with an error (${(res && res.status) || 'no reply'}).` };
    }
    const results = res.body.results.filter(r => r && typeof r.domain === 'string').map(r => {
        const available = isTrue(r.available);
        return {
            domain: String(r.domain).toLowerCase(),
            available,
            years: available ? Number(r.years) || null : null,
            costCents: available ? toCents(r.price) : null,
            renewalCents: available ? toCents(r.renewalPrice) : null,
            premium: available ? isTrue(r.premium) : false,
        };
    });
    return { ok: true, results };
}

module.exports = { searchDomains, setTransport, defaultTransport };
