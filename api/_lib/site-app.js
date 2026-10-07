// Gives a site its Deriv App ID, and keeps the app's markup/redirect in step with the site.
//   1. Preferred: create a fresh app for the site through Deriv's API (app_source = 'api').
//   2. Fallback:  the next unused app of the same markup from the pre-made pool.
//   3. Otherwise: the site waits as "awaiting App ID" and the admin can retry.
const { logEvent } = require('./events');
const { tryAssign } = require('./app-pool');
const deriv = require('./deriv-apps');

const loadSite = async (sql, siteId) =>
    (await sql`SELECT id, name, domain, plan, markup_percent, app_id, app_source FROM sites WHERE id = ${siteId} LIMIT 1`)[0] || null;

// Safe text for the history and the admin panel: no tokens, no long dumps.
const reasonOf = err => String((err && err.message) || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 200);

// Returns { app_id, source } on success, or { app_id: null, error } when the site still has no app.
async function provisionApp(sql, siteId) {
    const site = await loadSite(sql, siteId);
    if (!site) return { app_id: null, error: 'Site not found.' };
    if (site.app_id) return { app_id: site.app_id, source: site.app_source || 'existing' };

    let error = '';
    if (deriv.isConfigured()) {
        // Claim the site first so two requests at the same moment cannot create two apps (a claim older than 2 minutes counts as abandoned).
        const claim = await sql`
            UPDATE sites SET app_source = 'creating', updated_at = now()
            WHERE id = ${siteId} AND app_id IS NULL
              AND (app_source IS NULL OR app_source <> 'creating' OR updated_at < now() - interval '2 minutes')
            RETURNING id`;
        if (!claim.length) return { app_id: null, error: 'An app is already being created for this site.' };
        try {
            const appId = await deriv.registerApp(site);
            const saved = await sql`
                UPDATE sites SET app_id = ${appId}, app_source = 'api', updated_at = now()
                WHERE id = ${siteId} AND app_id IS NULL RETURNING app_id`;
            if (saved.length) {
                await logEvent(sql, siteId, 'app_id_assigned', { auto: true, source: 'deriv_api' });
                return { app_id: appId, source: 'api' };
            }
            error = 'The site already received an App ID.';
        } catch (err) {
            error = reasonOf(err);
            console.error('deriv app create failed for site', siteId, error);
        }
        await sql`UPDATE sites SET app_source = NULL WHERE id = ${siteId} AND app_source = 'creating'`;
        await logEvent(sql, siteId, 'app_create_failed', { reason: error });
    } else {
        error = 'Automatic app creation is off (DERIV_ADMIN_TOKEN is not set).';
    }

    const pooled = await tryAssign(sql, siteId, Number(site.markup_percent));
    if (pooled) return { app_id: pooled, source: 'pool' };
    return { app_id: null, error };
}

// The operator (or admin) changed the markup of a site that has an API-created app: change it on Deriv too.
// Throws if Deriv refuses, so the caller can leave the site unchanged.
async function syncAppToDeriv(sql, site, changes) {
    const appId = site.app_id;
    await deriv.updateApp(appId, { ...site, ...changes });
}

module.exports = { provisionApp, syncAppToDeriv, loadSite, reasonOf };
