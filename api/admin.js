const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const S = require('./_lib/site-settings');
const { logEvent } = require('./_lib/events');

const send = (res, code, body) => res.status(code).json(body);
const n = v => (v === undefined ? null : v);
const STATUSES = ['active', 'pending', 'suspended'];

const effectiveShare = r =>
    r.commission_rate_override !== null && r.commission_rate_override !== undefined
        ? Number(r.commission_rate_override)
        : S.PLAN_SHARE[r.plan];

const audit = (sql, adminId, action, target, detail) =>
    sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${adminId}, ${action}, ${String(target)}, ${JSON.stringify(detail || {})}::jsonb)`;

// Admin API. Locked down three ways:
//   1. only answers on YOUR domains (PLATFORM_HOSTS) -- and refuses to run at all if that is unset
//   2. needs a valid session whose account has role 'admin' (created only by scripts/create-admin.js)
//   3. state-changing calls must come from the same site (no cross-site posts)
//
//   GET  /api/admin?resource=sites | owners | audit
//   POST /api/admin  { action: set_status | update_site | approve_custom | set_app_id | set_markup | set_rate | disable_owner | delete_site | delete_owner, ... }
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'strict')) return send(res, 404, { error: 'Not found' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'admin') return send(res, 403, { error: 'Admins only.' });

        if (req.method === 'GET') {
            const resource = String(req.query.resource || 'sites');
            if (resource === 'sites') {
                const rows = await sql`
                    SELECT s.id, s.domain, s.name, s.plan, s.status, s.custom_domain_requested, s.commission_rate_override, s.markup_percent, s.app_id,
                           (s.app_id IS NOT NULL AND EXISTS (
                               SELECT 1 FROM site_events e WHERE e.site_id = s.id AND e.event = 'markup_changed'
                                 AND e.id > COALESCE((SELECT max(x.id) FROM site_events x WHERE x.site_id = s.id AND x.event IN ('app_id_assigned', 'markup_confirmed')), 0)
                           )) AS markup_pending,
                           s.created_at, o.email AS owner_email, o.name AS owner_name
                    FROM sites s LEFT JOIN owners o ON o.id = s.owner_id
                    ORDER BY s.created_at DESC LIMIT 500
                `;
                return send(res, 200, { sites: rows.map(r => ({ ...r, platform_share: effectiveShare(r) })) });
            }
            if (resource === 'owners') {
                const rows = await sql`SELECT id, email, name, role, disabled, created_at FROM owners ORDER BY created_at DESC LIMIT 500`;
                return send(res, 200, { owners: rows });
            }
            if (resource === 'audit') {
                const rows = await sql`SELECT id, owner_id, action, target, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 200`;
                return send(res, 200, { audit: rows });
            }
            return send(res, 400, { error: 'Unknown resource' });
        }

        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
        const body = A.readBody(req);
        const siteId = Number(body.site_id);

        const getSite = async () =>
            (await sql`SELECT id, domain, plan, status, custom_domain_requested, commission_rate_override FROM sites WHERE id = ${siteId} LIMIT 1`)[0];

        switch (body.action) {
            case 'set_status': {
                if (!STATUSES.includes(body.status)) return send(res, 400, { error: 'Invalid status.' });
                const r = await sql`UPDATE sites SET status = ${body.status}, updated_at = now() WHERE id = ${siteId} RETURNING id`;
                if (!r.length) return send(res, 404, { error: 'Site not found.' });
                await audit(sql, me.id, 'set_status', siteId, { status: body.status });
                await logEvent(sql, siteId, 'status_changed', { status: body.status });
                return send(res, 200, { ok: true });
            }

            case 'update_site': {
                const site = await getSite();
                if (!site) return send(res, 404, { error: 'Site not found.' });
                const checked = S.validateSiteInput(body, { allowDomain: true });
                if (!checked.ok) return send(res, 400, { error: 'Please fix the highlighted fields.', fields: checked.errors });
                const v = checked.value;
                try {
                    await sql`
                        UPDATE sites SET
                            name = COALESCE(${n(v.name)}, name), domain = COALESCE(${n(v.domain)}, domain),
                            primary_color = COALESCE(${n(v.primary_color)}, primary_color), font = COALESCE(${n(v.font)}, font),
                            logo_url = COALESCE(${n(v.logo_url)}, logo_url), about = COALESCE(${n(v.about)}, about),
                            vision = COALESCE(${n(v.vision)}, vision), mission = COALESCE(${n(v.mission)}, mission),
                            whatsapp = COALESCE(${n(v.whatsapp)}, whatsapp), phone = COALESCE(${n(v.phone)}, phone),
                            support_email = COALESCE(${n(v.support_email)}, support_email), telegram = COALESCE(${n(v.telegram)}, telegram),
                            updated_at = now()
                        WHERE id = ${siteId}
                    `;
                } catch (err) {
                    if (err && err.code === '23505') return send(res, 409, { error: 'That domain is already used by another site.' });
                    throw err;
                }
                await audit(sql, me.id, 'update_site', siteId, v);
                return send(res, 200, { ok: true });
            }

            // Moves a free site onto the operator's own domain, from now on at the custom-plan rate.
            case 'approve_custom': {
                const site = await getSite();
                if (!site) return send(res, 404, { error: 'Site not found.' });
                if (site.plan !== 'free' || !site.custom_domain_requested) return send(res, 400, { error: 'No pending custom-domain request for this site.' });
                try {
                    await sql`
                        UPDATE sites SET domain = custom_domain_requested, custom_domain_requested = NULL,
                                         plan = 'custom', status = 'active', updated_at = now()
                        WHERE id = ${siteId}
                    `;
                } catch (err) {
                    if (err && err.code === '23505') return send(res, 409, { error: 'That domain is already used by another site.' });
                    throw err;
                }
                const share = site.commission_rate_override !== null ? Number(site.commission_rate_override) : S.PLAN_SHARE.custom;
                await sql`INSERT INTO site_rate_history (site_id, plan, platform_share) VALUES (${siteId}, 'custom', ${share})`;
                await logEvent(sql, siteId, 'custom_domain_approved', { domain: site.custom_domain_requested });
                await audit(sql, me.id, 'approve_custom', siteId, { from: site.domain, to: site.custom_domain_requested, platform_share: share });
                return send(res, 200, { ok: true });
            }

            // The Deriv app you created for this site. Blank clears it (back to "awaiting").
            case 'set_app_id': {
                const site = await getSite();
                if (!site) return send(res, 404, { error: 'Site not found.' });
                const raw = String(body.app_id === undefined || body.app_id === null ? '' : body.app_id).trim();
                const appId = raw === '' ? null : S.sanitizeAppId(raw);
                if (raw !== '' && appId === null) return send(res, 400, { error: 'An App ID uses letters and numbers only.' });
                await sql`UPDATE sites SET app_id = ${appId}, updated_at = now() WHERE id = ${siteId}`;
                await audit(sql, me.id, 'set_app_id', siteId, { app_id: appId });
                await logEvent(sql, siteId, appId ? 'app_id_assigned' : 'app_id_cleared', {});
                return send(res, 200, { ok: true });
            }

            // Keep this equal to the markup you set on the site's Deriv app.
            case 'set_markup': {
                const site = await getSite();
                if (!site) return send(res, 404, { error: 'Site not found.' });
                const markup = S.sanitizeMarkup(body.markup_percent);
                if (markup === null) return send(res, 400, { error: `Markup must be between ${S.MARKUP_MIN} and ${S.MARKUP_MAX}%.` });
                await sql`UPDATE sites SET markup_percent = ${markup}, updated_at = now() WHERE id = ${siteId}`;
                await audit(sql, me.id, 'set_markup', siteId, { markup_percent: markup });
                await logEvent(sql, siteId, 'markup_confirmed', { markup_percent: markup });
                return send(res, 200, { ok: true });
            }

            // Per-operator deal. null clears the override and goes back to the plan default.
            case 'set_rate': {
                const site = await getSite();
                if (!site) return send(res, 404, { error: 'Site not found.' });
                let share = body.platform_share;
                if (share !== null) {
                    share = Number(share);
                    if (!Number.isFinite(share) || share < 0 || share > 100) return send(res, 400, { error: 'Share must be between 0 and 100.' });
                }
                await sql`UPDATE sites SET commission_rate_override = ${share}, updated_at = now() WHERE id = ${siteId}`;
                const effective = share === null ? S.PLAN_SHARE[site.plan] : share;
                await sql`INSERT INTO site_rate_history (site_id, plan, platform_share) VALUES (${siteId}, ${site.plan}, ${effective})`;
                await audit(sql, me.id, 'set_rate', siteId, { platform_share: effective });
                return send(res, 200, { ok: true });
            }

            // Permanently removes a site (and its rate history). Audit entry keeps what was removed.
            case 'delete_site': {
                const site = (await sql`SELECT id, domain, name, plan, owner_id FROM sites WHERE id = ${siteId} LIMIT 1`)[0];
                if (!site) return send(res, 404, { error: 'Site not found.' });
                await sql`DELETE FROM sites WHERE id = ${siteId}`;
                await audit(sql, me.id, 'delete_site', siteId, { domain: site.domain, name: site.name, plan: site.plan });
                return send(res, 200, { ok: true });
            }

            // Permanently removes an operator account AND their site(s). Admin accounts cannot be deleted here.
            case 'delete_owner': {
                const ownerId = Number(body.owner_id);
                if (ownerId === me.id) return send(res, 400, { error: 'You cannot delete your own account.' });
                const owner = (await sql`SELECT id, email, role FROM owners WHERE id = ${ownerId} LIMIT 1`)[0];
                if (!owner) return send(res, 404, { error: 'Account not found.' });
                if (owner.role !== 'operator') return send(res, 400, { error: 'Only operator accounts can be deleted here.' });
                const gone = await sql`DELETE FROM sites WHERE owner_id = ${ownerId} RETURNING domain`;
                await sql`DELETE FROM owners WHERE id = ${ownerId}`; // sessions go with it (ON DELETE CASCADE)
                await audit(sql, me.id, 'delete_owner', ownerId, { email: owner.email, sites_removed: gone.map(g => g.domain) });
                return send(res, 200, { ok: true, sites_removed: gone.length });
            }

            case 'disable_owner': {
                const ownerId = Number(body.owner_id);
                if (ownerId === me.id) return send(res, 400, { error: 'You cannot disable your own account.' });
                const disabled = body.disabled !== false;
                const r = await sql`UPDATE owners SET disabled = ${disabled} WHERE id = ${ownerId} AND role = 'operator' RETURNING id`;
                if (!r.length) return send(res, 404, { error: 'Operator not found.' });
                if (disabled) await sql`DELETE FROM sessions WHERE owner_id = ${ownerId}`;
                await audit(sql, me.id, 'disable_owner', ownerId, { disabled });
                return send(res, 200, { ok: true });
            }

            default:
                return send(res, 400, { error: 'Unknown action' });
        }
    } catch (err) {
        console.error('admin error:', err);
        return send(res, 500, { error: 'Something went wrong.' });
    }
};
