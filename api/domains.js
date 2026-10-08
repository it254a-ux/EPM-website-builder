const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const R = require('./_lib/vercel-registrar');
const P = require('./_lib/domain-pricing');
const FX = require('./_lib/fx');

const send = (res, code, body) => res.status(code).json(body);

// The endings we search for every name.
const TLDS = ['com', 'net', 'org', 'xyz', 'site', 'online', 'tech', 'store', 'trading'];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// An operator searches for a domain name. Shows availability and the operator's price. Nothing is bought or charged here.
//   GET /api/domains?name=mybrand   ->  { name, kes_available, rate_credit, results: [...] }
// Never returns what Vercel charges you, your profit, or the exchange rate.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'operator') return send(res, 403, { error: 'Use the admin panel for admin accounts.' });
        if ((await A.hit(sql, `domainsearch:owner:${me.id}`, 600)) > 30) return send(res, 429, { error: 'Too many searches. Please wait a few minutes.' });

        const label = String((req.query && req.query.name) || '').trim().toLowerCase().split('.')[0];
        if (!LABEL.test(label)) return send(res, 400, { error: 'Use only letters, numbers and hyphens, with no spaces, and do not start or end with a hyphen.' });

        const found = await R.searchDomains(TLDS.map(t => `${label}.${t}`));
        if (!found.ok) return send(res, 502, { error: 'Domain search is not available right now. Please try again in a minute.' });

        const rate = await FX.currentRate(sql);
        const s = { ...P.settings(), kesPerUsd: rate ? rate.rate : 0 };
        const order = new Map(TLDS.map((t, i) => [`${label}.${t}`, i]));

        const results = found.results.filter(r => order.has(r.domain)).sort((a, b) => order.get(a.domain) - order.get(b.domain)).map(r => {
            const base = { domain: r.domain, available: r.available };
            if (!r.available) return base;
            // Premium names and multi-year-only endings are not sold yet: their prices need separate handling.
            if (r.premium) return { ...base, offered: false, reason: 'Premium names are not sold here.' };
            if (r.years !== 1) return { ...base, offered: false, reason: 'This ending cannot be bought here yet.' };
            const first = r.costCents ? P.priceFor(r.costCents / 100, s) : null;
            const renew = r.renewalCents ? P.priceFor(r.renewalCents / 100, s) : null;
            if (!first || !renew) return { ...base, offered: false, reason: 'No price is available for this name right now.' };
            return {
                ...base, offered: true, years: 1,
                price_usd: first.priceCents / 100, price_kes: P.toKes(first.priceCents, s),
                renewal_usd: renew.priceCents / 100, renewal_kes: P.toKes(renew.priceCents, s),
            };
        });

        return send(res, 200, { name: label, kes_available: !!(rate && rate.rate > 0), rate_credit: !!(rate && rate.source === 'live'), results });
    } catch (err) {
        console.error('domains error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
