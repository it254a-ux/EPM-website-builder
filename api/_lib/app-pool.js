const { logEvent } = require('./events');

// Gives a site the next unused pre-made Deriv app with EXACTLY this markup.
// One SQL statement, so two sites can never be given the same app. Returns the App ID, or null if none is free
// (the site then simply waits as "awaiting App ID" until you add more apps).
async function assignFromPool(sql, siteId, markup) {
    const rows = await sql`
        WITH picked AS (
            UPDATE app_pool SET site_id = ${siteId}, assigned_at = now()
            WHERE assigned_at IS NULL
              AND id = (SELECT id FROM app_pool WHERE assigned_at IS NULL AND markup_percent = ${markup} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
              AND EXISTS (SELECT 1 FROM sites WHERE id = ${siteId} AND app_id IS NULL)
            RETURNING app_id
        )
        UPDATE sites SET app_id = (SELECT app_id FROM picked), updated_at = now()
        WHERE id = ${siteId} AND app_id IS NULL AND EXISTS (SELECT 1 FROM picked)
        RETURNING app_id
    `;
    if (!rows.length) return null;
    await logEvent(sql, siteId, 'app_id_assigned', { auto: true });
    return rows[0].app_id;
}

// Same, but never lets a missing/broken pool stop the main action (creating or editing a site).
async function tryAssign(sql, siteId, markup) {
    try { return await assignFromPool(sql, siteId, markup); } catch (err) { console.error('app pool error:', err); return null; }
}

// After you add apps: hand them to sites that were already waiting, oldest first.
async function assignWaiting(sql, markup) {
    const waiting = await sql`SELECT id FROM sites WHERE app_id IS NULL AND markup_percent = ${markup} ORDER BY created_at, id`;
    let n = 0;
    for (const w of waiting) {
        if (await assignFromPool(sql, w.id, markup)) n += 1; else break;
    }
    return n;
}

module.exports = { assignFromPool, tryAssign, assignWaiting };
