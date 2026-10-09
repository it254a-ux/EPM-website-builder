const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const R = require('./_lib/vercel-registrar');
const P = require('./_lib/domain-pricing');
const FX = require('./_lib/fx');
const M = require('./_lib/mpesa');
const DO = require('./_lib/domain-orders');

const send = (res, code, body) => res.status(code).json(body);

// The endings we search for every name.
const TLDS = ['com', 'net', 'org', 'xyz', 'site', 'online', 'tech', 'store', 'trading'];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// An operator searches for a domain name. Shows availability and the operator's price. Nothing is bought or charged here.
//   GET /api/domains?name=mybrand   ->  { name, kes_available, rate_credit, results: [...] }
// Never returns what Vercel charges you, your profit, or the exchange rate.
async function search(sql, me, req, res) {
    {
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
    }
}

const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const ownSite = async (sql, ownerId) => (await sql`SELECT id, plan, domain, status FROM sites WHERE owner_id = ${ownerId} LIMIT 1`)[0] || null;

// Registrant details the registry requires. Returns { contact } or { errors }.
function readContact(b, email, phoneIntl) {
    const c = (b && typeof b.contact === 'object' && b.contact) || {}, errors = {};
    const need = (key, label, max) => { const v = clip(c[key], max); if (!v) errors[key] = `Enter your ${label}.`; return v; };
    const out = {
        firstName: need('first_name', 'first name', 60), lastName: need('last_name', 'last name', 60), email,
        phone: phoneIntl, address1: need('address1', 'address', 100), city: need('city', 'town or city', 60),
        state: need('state', 'county or region', 60), zip: need('zip', 'postal code', 20),
        country: clip(c.country || 'KE', 10).toUpperCase(),
    };
    if (!/^[A-Z]{2}$/.test(out.country)) errors.country = 'Use a two-letter country code such as KE.';
    return Object.keys(errors).length ? { errors } : { contact: out };
}

async function placeOrder(sql, me, req, res, body) {
    if ((await A.hit(sql, `domainorder:owner:${me.id}`, 3600)) > 12) return send(res, 429, { error: 'Too many attempts. Please wait a while.' });
    if (!M.isConfigured()) return send(res, 503, { error: 'Payments are not switched on yet. Please try again later.' });
    const rate = await FX.currentRate(sql);
    if (!rate) return send(res, 503, { error: 'Prices in shillings are not available right now. Please try again later.' });

    const site = await ownSite(sql, me.id);
    if (!site) return send(res, 400, { error: 'Create your site first.' });
    if (site.plan !== 'free') return send(res, 400, { error: 'Your site already uses its own domain.' });

    const domain = clip(body.domain, 253).toLowerCase();
    const m = domain.match(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)\.([a-z]+)$/);
    if (!m || !TLDS.includes(m[3])) return send(res, 400, { error: 'Choose a domain from the search results.' });
    const phone = M.normalizePhone(body.phone);
    if (!phone) return send(res, 400, { error: 'Enter your Safaricom number, for example 0712345678.', fields: { phone: 'Enter a Safaricom number such as 0712345678.' } });
    const parsed = readContact(body, me.email, '+' + phone);
    if (parsed.errors) return send(res, 400, { error: 'Please fix the highlighted fields.', fields: parsed.errors });

    // Ask the registrar again right now: still free, still one year, still not premium. The price is fixed from this answer.
    const found = await R.searchDomains([domain]);
    const hit = found.ok && found.results.find(r => r.domain === domain);
    if (!found.ok) return send(res, 502, { error: 'Could not check the domain right now. Please try again in a minute.' });
    if (!hit || !hit.available || hit.premium || hit.years !== 1 || !hit.costCents || !hit.renewalCents) return send(res, 409, { error: 'That domain is no longer available. Please search again.' });
    const s = { ...P.settings(), kesPerUsd: rate.rate };
    const first = P.priceFor(hit.costCents / 100, s), renew = P.priceFor(hit.renewalCents / 100, s);
    const kes = first && P.toKes(first.priceCents, s);
    if (!first || !renew || !kes) return send(res, 503, { error: 'No price is available for this domain right now.' });

    await DO.expireStale(sql);
    await sql`UPDATE domain_orders SET status = 'cancelled', updated_at = now() WHERE owner_id = ${me.id} AND status = 'awaiting_payment'`;
    let order;
    try {
        order = (await sql`
            INSERT INTO domain_orders (owner_id, site_id, kind, domain, years, price_usd_cents, price_kes, cost_usd_cents, renewal_usd_cents, renewal_cost_cents, fx_rate, phone, contact, expires_at)
            VALUES (${me.id}, ${site.id}, 'purchase', ${domain}, 1, ${first.priceCents}, ${kes}, ${hit.costCents}, ${renew.priceCents}, ${hit.renewalCents}, ${rate.rate}, ${phone}, ${JSON.stringify(parsed.contact)}::jsonb,
                    now() + (${DO.PAY_WINDOW_MINUTES} || ' minutes')::interval)
            RETURNING *`)[0];
    } catch (err) {
        if (err && err.code === '23505') return send(res, 409, { error: 'Someone else is buying that domain right now. Try again in a few minutes.' });
        throw err;
    }

    const host = A.requestHost(req);
    const callbackUrl = `https://${host}/api/pay-callback?k=${encodeURIComponent(M.settings().callbackSecret)}`;
    const push = await M.stkPush({ phone, amountKes: kes, reference: `EPM${order.id}`, description: 'Domain', callbackUrl });
    if (!push.ok) {
        await sql`UPDATE domain_orders SET status = 'cancelled', failure_reason = 'Could not send the payment prompt', updated_at = now() WHERE id = ${order.id}`;
        return send(res, 502, { error: push.error });
    }
    order = (await sql`UPDATE domain_orders SET mpesa_merchant_id = ${push.merchantId}, mpesa_checkout_id = ${push.checkoutId}, updated_at = now() - interval '1 minute' WHERE id = ${order.id} RETURNING *`)[0];
    return send(res, 201, { order: DO.view(order) });
}

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'operator') return send(res, 403, { error: 'Use the admin panel for admin accounts.' });

        if (req.method === 'GET') {
            const q = req.query || {};
            if (q.order !== undefined) {
                const id = Number(q.order);
                let o = Number.isInteger(id) ? await DO.get(sql, id) : null;
                if (!o || o.owner_id !== me.id) return send(res, 404, { error: 'Order not found.' });
                if (o.status === 'awaiting_payment') { await DO.confirmWaiting(sql, o.id); o = await DO.get(sql, o.id); }
                if (o.status === 'paid') { await DO.fulfil(sql, o.id); o = await DO.get(sql, o.id); }
                return send(res, 200, { order: DO.view(o) });
            }
            if (q.orders !== undefined) {
                const rows = await sql`SELECT * FROM domain_orders WHERE owner_id = ${me.id} ORDER BY id DESC LIMIT 50`;
                return send(res, 200, { orders: rows.map(DO.view) });
            }
            return search(sql, me, req, res);
        }

        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Forbidden' });
        const body = A.readBody(req);
        if (body.action === 'order') return placeOrder(sql, me, req, res, body);
        if (body.action === 'cancel') {
            const r = await sql`UPDATE domain_orders SET status = 'cancelled', updated_at = now() WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} AND status = 'awaiting_payment' RETURNING id`;
            return send(res, 200, { ok: true, cancelled: r.length === 1 });
        }
        return send(res, 400, { error: 'Unknown action.' });
    } catch (err) {
        console.error('domains error:', err && err.message);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
