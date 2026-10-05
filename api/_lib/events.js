// Best-effort site history. If the site_events table has not been created yet
// (schema.sql not re-run), these quietly do nothing so the main feature still works.
async function logEvent(sql, siteId, event, detail) {
    try {
        await sql`INSERT INTO site_events (site_id, event, detail) VALUES (${siteId}, ${event}, ${JSON.stringify(detail || {})}::jsonb)`;
    } catch (err) {
        /* table not there yet -- ignore */
    }
}

async function listEvents(sql, siteId) {
    try {
        return await sql`SELECT event, detail, created_at FROM site_events WHERE site_id = ${siteId} ORDER BY id DESC LIMIT 50`;
    } catch (err) {
        return [];
    }
}

module.exports = { logEvent, listEvents };
