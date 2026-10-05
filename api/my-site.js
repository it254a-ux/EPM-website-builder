const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const S = require('./_lib/site-settings');
const { logEvent, listEvents } = require('./_lib/events');
const { checkDomain } = require('./_lib/dns-check');

const send = (res, code, body) => res.status(code).json(body);
const n = v => (v === undefined ? null : v);

const effectiveShare = row =>
    row.commission_rate_override !== null && row.commission_rate_override !== undefined
        ? Number(row.commission_rate_override)
        : S.PLAN_SHARE[row.plan];

// What an operator may see about THEIR OWN site (never anyone else's data).
const view = row => ({
    id: row.id, domain: row.domain, name: row.name, plan: row.plan, status: row.status,
    primary_color: row.primary_color || '', font: row.font || '', logo_url: row.logo_url || '',
    about: row.about || '', vision: row.vision || '', mission: row.mission || '',
    whatsapp: row.whatsapp || '', phone: row.phone || '', support_email: row.support_email || '', telegram: row.telegram || '',
    custom_domain_requested: row.custom_domain_requested || '',
    platform_share: effectiveShare(row),          // % the platform keeps
    operator_share: 100 - effectiveShare(row),    // % the operator receives
});

const findOwn = async (sql, ownerId) =>
    (await sql`
        SELECT id, domain, name, plan, status, primary_color, font, logo_url, about, vision, mission,
               whatsapp, phone, support_email, telegram, custom_domain_requested, commission_rate_override
        FROM sites WHERE owner_id = ${ownerId} LIMIT 1
    `)[0] || null;

// Domains an operator may never claim: yours, anything under your root domain, vercel.app.
const domainBlocked = domain => {
    const root = S.normalizeHost(process.env.PLATFORM_ROOT_DOMAIN);
    const platform = S.parsePlatformHosts(process.env.PLATFORM_HOSTS);
    return (
        platform.includes(domain) ||
        (root && (domain === root || domain.endsWith(`.${root}`))) ||
        domain.endsWith('.vercel.app')
    );
};

// GET  /api/my-site  -> your site (or { site: null })
// POST /api/my-site  -> create it: { name, subdomain } for a FREE site (live at once)
//                       or { name, custom_domain } for your own domain (waits for approval)
// PUT  /api/my-site  -> edit it, or { action: 'request_custom_domain', domain }
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'operator') return send(res, 403, { error: 'Use the admin panel for admin accounts.' });

        if (req.method === 'GET') {
            const row = await findOwn(sql, me.id);

            // ?check_dns=1 -> is the domain you asked for (or already use) pointing at the platform yet?
            if (req.query.check_dns) {
                const target = row && (row.custom_domain_requested || (row.plan === 'custom' ? row.domain : ''));
                if (!target) return send(res, 400, { error: 'No custom domain to check yet.' });
                if ((await A.hit(sql, `dns:owner:${me.id}`, 3600)) > 30) return send(res, 429, { error: 'Too many checks. Try again in a while.' });
                return send(res, 200, { dns_check: await checkDomain(target) });
            }

            return send(res, 200, {
                site: row ? view(row) : null,
                dns: { cname: process.env.DNS_CNAME_TARGET || 'cname.vercel-dns-0.com', a: process.env.DNS_A_TARGET || '76.76.21.21' },
                events: row ? await listEvents(sql, row.id) : [],
            });
        }

        if (req.method !== 'POST' && req.method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
        const body = A.readBody(req);
        const row = await findOwn(sql, me.id);

        // ---------- create ----------
        if (req.method === 'POST') {
            if (row) return send(res, 409, { error: 'You already have a site. Edit it instead.' });

            const wantsCustom = typeof body.custom_domain === 'string' && body.custom_domain.trim() !== '';
            const plan = wantsCustom ? 'custom' : 'free';
            const checked = S.validateSiteInput(body, { requireName: true, ignoreContacts: plan === 'free' });
            const errors = { ...checked.errors };
            let domain = '';

            if (plan === 'free') {
                const root = S.normalizeHost(process.env.PLATFORM_ROOT_DOMAIN);
                if (!root) return send(res, 503, { error: 'Free sites are not enabled yet.' });
                // People naturally type the whole address (julias.example.com); accept that too.
                let typed = String(body.subdomain || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
                if (typed.endsWith(`.${root}`)) typed = typed.slice(0, -(root.length + 1));
                const sub = S.sanitizeSubdomain(typed);
                if (!sub) errors.subdomain = 'Use just the name, e.g. "julias": 3-30 letters, numbers or hyphens (some names are reserved).';
                else domain = `${sub}.${root}`;
            } else {
                domain = S.sanitizeDomain(body.custom_domain);
                if (!domain) errors.custom_domain = 'Enter a valid domain such as trade.yourbrand.com.';
                else if (domainBlocked(domain)) errors.custom_domain = 'That domain cannot be used.';
            }
            if (Object.keys(errors).length) return send(res, 400, { error: 'Please fix the highlighted fields.', fields: errors });

            const v = checked.value;
            const status = plan === 'free' ? 'active' : 'pending'; // free = live immediately; custom = needs your approval
            let created;
            try {
                created = (await sql`
                    INSERT INTO sites (owner_id, domain, name, plan, status, primary_color, font, logo_url, about, vision, mission,
                                       whatsapp, phone, support_email, telegram)
                    VALUES (${me.id}, ${domain}, ${v.name}, ${plan}, ${status}, ${n(v.primary_color)}, ${n(v.font)}, ${n(v.logo_url)},
                            ${n(v.about)}, ${n(v.vision)}, ${n(v.mission)},
                            ${plan === 'custom' ? n(v.whatsapp) : null}, ${plan === 'custom' ? n(v.phone) : null},
                            ${plan === 'custom' ? n(v.support_email) : null}, ${plan === 'custom' ? n(v.telegram) : null})
                    RETURNING id
                `)[0];
            } catch (err) {
                if (err && err.code === '23505') {
                    return send(res, 409, { error: 'That address is already taken.', fields: { [plan === 'free' ? 'subdomain' : 'custom_domain']: 'Already taken.' } });
                }
                throw err;
            }
            await sql`INSERT INTO site_rate_history (site_id, plan, platform_share) VALUES (${created.id}, ${plan}, ${S.PLAN_SHARE[plan]})`;
            await logEvent(sql, created.id, 'site_created', { plan, domain, status });
            return send(res, 201, { site: view(await findOwn(sql, me.id)) });
        }

        // ---------- update ----------
        if (!row) return send(res, 404, { error: 'Create your site first.' });

        if (body.action === 'request_custom_domain') {
            if (row.plan !== 'free') return send(res, 400, { error: 'This site already uses its own domain.' });
            const domain = S.sanitizeDomain(body.domain);
            if (!domain || domainBlocked(domain)) return send(res, 400, { error: 'Enter a valid domain you own, such as trade.yourbrand.com.' });
            try {
                await sql`UPDATE sites SET custom_domain_requested = ${domain}, updated_at = now() WHERE id = ${row.id}`;
            } catch (err) {
                throw err;
            }
            await logEvent(sql, row.id, 'custom_domain_requested', { domain });
            return send(res, 200, { site: view(await findOwn(sql, me.id)) });
        }

        // Operators can edit ONLY these fields: never domain, plan, status or commission.
        const checked = S.validateSiteInput(body, { ignoreContacts: row.plan === 'free' });
        if (!checked.ok) return send(res, 400, { error: 'Please fix the highlighted fields.', fields: checked.errors });
        const v = checked.value;
        await sql`
            UPDATE sites SET
                name = COALESCE(${n(v.name)}, name),
                primary_color = COALESCE(${n(v.primary_color)}, primary_color),
                font = COALESCE(${n(v.font)}, font),
                logo_url = COALESCE(${n(v.logo_url)}, logo_url),
                about = COALESCE(${n(v.about)}, about),
                vision = COALESCE(${n(v.vision)}, vision),
                mission = COALESCE(${n(v.mission)}, mission),
                whatsapp = COALESCE(${n(v.whatsapp)}, whatsapp),
                phone = COALESCE(${n(v.phone)}, phone),
                support_email = COALESCE(${n(v.support_email)}, support_email),
                telegram = COALESCE(${n(v.telegram)}, telegram),
                updated_at = now()
            WHERE id = ${row.id} AND owner_id = ${me.id}
        `;
        await logEvent(sql, row.id, 'details_updated', {});
        return send(res, 200, { site: view(await findOwn(sql, me.id)) });
    } catch (err) {
        console.error('my-site error:', err);
        return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
};
