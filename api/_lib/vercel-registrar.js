// Searches Vercel's domain registrar for availability and prices.
//   POST https://api.vercel.com/v1/registrar/domains/search   { domains: [...] }   (up to 200 names; Vercel's docs say no sign-in is needed)
//   An available domain comes back as { domain, available, years, price, renewalPrice, premium }; a taken one as { domain, available }.
// We do NOT send your Vercel token here, so a wrong token can never break searching.
// UNTESTED against live Vercel: the first real search is the real test. Prices are in US dollars.
//
// Searching only reads. Buying and renewing (below) spend your money and use DOMAINS_VERCEL_TOKEN (+ DOMAINS_VERCEL_TEAM if the project is in a team).
// UNTESTED against live Vercel for buying and renewing.

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

// ---------- spending money: buy and renew ----------
// Both answer { ok:true, orderId } or { ok:false, kind, message } where kind says what to do next:
//   definite  the registrar said no (name taken, price changed, bad details...). Nothing was bought. Refund the customer.
//   retry     nothing was bought and trying again later may work (rate limit, token or setup problem).
//   unclear   we cannot tell whether it went through (timeout, server error). Do NOT retry or refund: a person must check Vercel.
const clean = t => String(t || '').replace(/[\r\n]+/g, ' ').slice(0, 160);

async function registrarPost(path, payload) {
    const token = env('DOMAINS_VERCEL_TOKEN'), team = env('DOMAINS_VERCEL_TEAM');
    if (!token) return { ok: false, kind: 'retry', message: 'DOMAINS_VERCEL_TOKEN is not set in Vercel.' };
    let res;
    try {
        res = await transport(`${BASE()}${path}` + (team ? `?teamId=${encodeURIComponent(team)}` : ''), {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
    } catch (err) { return { ok: false, kind: 'unclear', message: 'No answer from Vercel (timeout or network). It may or may not have gone through.' }; }
    const status = res && res.status, b = (res && res.body) || {};
    if (status === 200 || status === 201) {
        return b.orderId ? { ok: true, orderId: String(b.orderId).slice(0, 80) } : { ok: false, kind: 'unclear', message: 'Vercel said OK but gave no order number. Check Vercel.' };
    }
    const why = `${clean(b.code)}${b.code && b.message ? ': ' : ''}${clean(b.message)}`.trim() || `error ${status || 'no reply'}`;
    if (status === 429) return { ok: false, kind: 'retry', message: 'Vercel asked us to slow down: ' + why };
    if (status === 401 || status === 403) return { ok: false, kind: 'retry', message: 'Vercel refused the token or its permissions: ' + why };
    if (status >= 500 || !status) return { ok: false, kind: 'unclear', message: 'Vercel had a server error: ' + why };
    return { ok: false, kind: 'definite', message: why };
}

// contact: { firstName, lastName, email, phone, address1, city, state, zip, country } (phone like +254712345678, country like KE)
const buyDomain = ({ domain, years, expectedPriceUsd, contact }) =>
    registrarPost(`/v1/registrar/domains/${encodeURIComponent(domain)}/buy`, { autoRenew: false, years, expectedPrice: expectedPriceUsd, contactInformation: contact });
const renewDomain = ({ domain, years, expectedPriceUsd }) =>
    registrarPost(`/v1/registrar/domains/${encodeURIComponent(domain)}/renew`, { years, expectedPrice: expectedPriceUsd });

// What Vercel would charge to renew a domain we own, in US cents. { ok:true, renewalCents } or { ok:false }.
// GET /v1/registrar/domains/{domain}/price?years=1 answers { years, purchasePrice, renewalPrice, transferPrice } (numbers or numeric text).
async function renewalPrice(domain) {
    let res;
    try { res = await transport(`${BASE()}/v1/registrar/domains/${encodeURIComponent(domain)}/price?years=1` + (env('DOMAINS_VERCEL_TEAM') ? `&teamId=${encodeURIComponent(env('DOMAINS_VERCEL_TEAM'))}` : ''), { method: 'GET', headers: env('DOMAINS_VERCEL_TOKEN') ? { Authorization: `Bearer ${env('DOMAINS_VERCEL_TOKEN')}` } : {} }); }
    catch (err) { return { ok: false }; }
    const cents = res && res.status === 200 && res.body ? toCents(res.body.renewalPrice) : null;
    return cents ? { ok: true, renewalCents: cents } : { ok: false };
}

module.exports = { searchDomains, buyDomain, renewDomain, renewalPrice, setTransport, defaultTransport };
