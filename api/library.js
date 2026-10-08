const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');
const L = require('./_lib/library');

const send = (res, code, body) => res.status(code).json(body);
const fail = (res, v) => send(res, 400, { error: v.error, fields: { [v.field]: v.error } });
const audit = (sql, ownerId, action, target, detail) =>
    sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${ownerId}, ${action}, ${String(target)}, ${JSON.stringify(detail || {})}::jsonb)`;

// An operator's own bots, strategy documents and bot requests, for THEIR site only.
//   GET  /api/library
//   POST /api/library { action: add_bot | update_bot | delete_bot | add_strategy | delete_strategy | request_bot | cancel_request, ... }
// Bots go live at once. You can remove any of them from the admin panel.
module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });
    const sql = getDb();

    try {
        const me = await A.getSession(sql, req);
        if (!me) return send(res, 401, { error: 'Please sign in.' });
        if (me.role !== 'operator') return send(res, 403, { error: 'Use the admin panel for admin accounts.' });

        if (req.method === 'GET') return send(res, 200, await L.operatorView(sql, me.id));
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
        const body = A.readBody(req);
        const site = (await sql`SELECT id, domain FROM sites WHERE owner_id = ${me.id} LIMIT 1`)[0] || null;
        const needSite = () => { if (site) return false; send(res, 400, { error: 'Create your site first.' }); return true; };

        switch (body.action) {
            case 'add_bot': {
                if (needSite()) return;
                if ((await A.hit(sql, `lib:bot:${me.id}`, 3600)) > 30) return send(res, 429, { error: 'Too many uploads. Please try again later.' });
                const v = L.validateBot(body);
                if (!v.value) return fail(res, v);
                const b = v.value;
                const r = await sql`
                    INSERT INTO site_bots (site_id, owner_id, name, description, market, risk_level, contract_type, xml_content)
                    SELECT ${site.id}, ${me.id}, ${b.name}, ${b.description}, ${b.market}, ${b.risk_level}, ${b.contract_type}, ${b.xml_content}
                    WHERE (SELECT count(*) FROM site_bots WHERE site_id = ${site.id}) < ${L.LIMITS.botsPerSite}
                    RETURNING id`;
                if (!r.length) return send(res, 400, { error: `You can have up to ${L.LIMITS.botsPerSite} bots. Delete one first.` });
                await audit(sql, me.id, 'bot_added', r[0].id, { site: site.domain, name: b.name });
                return send(res, 201, await L.operatorView(sql, me.id));
            }

            case 'update_bot': {
                if (needSite()) return;
                const v = L.validateBot(body, { partial: true });
                if (!v.value) return fail(res, v);
                const b = v.value;
                const r = await sql`
                    UPDATE site_bots SET name = ${b.name}, description = ${b.description}, market = ${b.market}, risk_level = ${b.risk_level},
                           contract_type = ${b.contract_type}, xml_content = COALESCE(${b.xml_content === undefined ? null : b.xml_content}, xml_content), updated_at = now()
                    WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} AND status = 'live' RETURNING id`;
                if (!r.length) return send(res, 404, { error: 'That bot is not available to edit.' });
                await audit(sql, me.id, 'bot_updated', r[0].id, { replaced_file: b.xml_content !== undefined });
                return send(res, 200, await L.operatorView(sql, me.id));
            }

            case 'delete_bot': {
                const r = await sql`DELETE FROM site_bots WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} RETURNING id`;
                if (!r.length) return send(res, 404, { error: 'Bot not found.' });
                await audit(sql, me.id, 'bot_deleted', r[0].id, {});
                return send(res, 200, await L.operatorView(sql, me.id));
            }

            case 'add_strategy': {
                if (needSite()) return;
                if (!L.storageReady()) return send(res, 503, { error: 'File uploads are not switched on yet. Please contact support.' });
                if ((await A.hit(sql, `lib:file:${me.id}`, 3600)) > 20) return send(res, 429, { error: 'Too many uploads. Please try again later.' });
                const v = L.validateStrategy(body);
                if (!v.value) return fail(res, v);
                const f = v.value;
                const have = Number((await sql`SELECT count(*)::int AS c FROM site_strategies WHERE site_id = ${site.id}`)[0].c);
                if (have >= L.LIMITS.strategiesPerSite) return send(res, 400, { error: `You can have up to ${L.LIMITS.strategiesPerSite} documents. Delete one first.` });
                let url;
                try {
                    url = await L.storeFile({ siteId: site.id, fileName: f.file_name, mime: f.mime, buffer: f.buffer });
                } catch (err) {
                    console.error('blob upload failed:', err && err.message);
                    return send(res, 502, { error: 'The file could not be saved. Please try again.' });
                }
                const r = await sql`
                    INSERT INTO site_strategies (site_id, owner_id, title, description, file_name, mime, size_bytes, blob_url)
                    SELECT ${site.id}, ${me.id}, ${f.title}, ${f.description}, ${f.file_name}, ${f.mime}, ${f.buffer.length}, ${url}
                    WHERE (SELECT count(*) FROM site_strategies WHERE site_id = ${site.id}) < ${L.LIMITS.strategiesPerSite}
                    RETURNING id`;
                if (!r.length) { await L.purgeFiles([url]); return send(res, 400, { error: `You can have up to ${L.LIMITS.strategiesPerSite} documents. Delete one first.` }); }
                await audit(sql, me.id, 'strategy_added', r[0].id, { site: site.domain, file: f.file_name, bytes: f.buffer.length });
                return send(res, 201, await L.operatorView(sql, me.id));
            }

            case 'delete_strategy': {
                const r = await sql`DELETE FROM site_strategies WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} RETURNING id, blob_url`;
                if (!r.length) return send(res, 404, { error: 'Document not found.' });
                await L.purgeFiles([r[0].blob_url]);
                await audit(sql, me.id, 'strategy_deleted', r[0].id, {});
                return send(res, 200, await L.operatorView(sql, me.id));
            }

            case 'request_bot': {
                if ((await A.hit(sql, `lib:req:${me.id}`, 3600)) > 10) return send(res, 429, { error: 'Too many requests. Please try again later.' });
                const title = L.clean(body.title, L.LIMITS.requestTitle);
                const details = L.clean(body.details, L.LIMITS.requestDetails);
                if (!title) return fail(res, { field: 'title', error: 'Give the bot idea a short title.' });
                if (details.length < 10) return fail(res, { field: 'details', error: 'Describe what the bot should do (at least a sentence).' });
                const r = await sql`
                    INSERT INTO bot_requests (owner_id, site_id, title, details)
                    SELECT ${me.id}, ${site ? site.id : null}, ${title}, ${details}
                    WHERE (SELECT count(*) FROM bot_requests WHERE owner_id = ${me.id} AND status = 'open') < ${L.LIMITS.openRequests}
                    RETURNING id`;
                if (!r.length) return send(res, 400, { error: `You already have ${L.LIMITS.openRequests} requests waiting. Please wait for answers first.` });
                await audit(sql, me.id, 'bot_requested', r[0].id, { title });
                return send(res, 201, await L.operatorView(sql, me.id));
            }

            case 'cancel_request': {
                const r = await sql`UPDATE bot_requests SET status = 'cancelled', decided_at = now() WHERE id = ${Number(body.id) || 0} AND owner_id = ${me.id} AND status = 'open' RETURNING id`;
                if (!r.length) return send(res, 404, { error: 'That request is not waiting any more.' });
                return send(res, 200, await L.operatorView(sql, me.id));
            }

            default:
                return send(res, 400, { error: 'Unknown action' });
        }
    } catch (err) {
        console.error('library error:', err);
        return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
};
