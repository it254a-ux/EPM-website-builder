// Step 4: an operator's own bots, strategy documents and bot requests.
// Your central bot library lives in the trading site (free_bots) and is not touched here.
const crypto = require('crypto');

const LIMITS = {
    botName: 120, botDescription: 2000, botXml: 200000, botsPerSite: 50,
    strategyTitle: 120, strategyDescription: 2000, strategiesPerSite: 50,
    fileBytes: 3 * 1024 * 1024,           // a JSON upload must stay under Vercel's 4.5 MB request limit, and base64 adds a third
    requestTitle: 120, requestDetails: 2000, openRequests: 5,
    note: 500,
};
const CONTRACT_TYPES = ['Accumulators', 'Rise/Fall', 'Matches/Differs', 'Over/Under', 'Even/Odd', 'Multiplier', 'Other'];
const RISK_LEVELS = ['Low', 'Medium', 'High'];

// Allowed strategy files: extension -> { mime, check(buffer) }. The first bytes must match, so a renamed file is refused.
const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const ZIP = b => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
const FILE_TYPES = {
    pdf: { mime: 'application/pdf', check: b => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: ZIP },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: ZIP },
    pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: ZIP },
    png: { mime: 'image/png', check: b => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
    jpg: { mime: 'image/jpeg', check: b => startsWith(b, [0xff, 0xd8, 0xff]) },
    jpeg: { mime: 'image/jpeg', check: b => startsWith(b, [0xff, 0xd8, 0xff]) },
    txt: { mime: 'text/plain; charset=utf-8', check: b => !b.includes(0) },
};

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// ---------- bots ----------
function validateBot(body, { partial = false } = {}) {
    const name = clean(body.name, LIMITS.botName);
    const description = clean(body.description, LIMITS.botDescription);
    const market = clean(body.market, 80);
    const risk = clean(body.risk_level, 20);
    const contract = clean(body.contract_type, 40);
    const xml = body.xml_content === undefined ? undefined : String(body.xml_content);

    if (!name) return { field: 'name', error: 'Give the bot a name.' };
    if (!description) return { field: 'description', error: 'Add a short description.' };
    if (!market) return { field: 'market', error: 'Say which market the bot trades, for example Volatility 100.' };
    if (!RISK_LEVELS.includes(risk)) return { field: 'risk_level', error: 'Choose Low, Medium or High risk.' };
    if (contract && !CONTRACT_TYPES.includes(contract)) return { field: 'contract_type', error: 'Choose a contract type from the list.' };
    if (xml === undefined || (partial && xml === '')) {
        if (!partial) return { field: 'xml_content', error: 'Choose the bot file (.xml).' };
    } else {
        const bad = checkBotXml(xml);
        if (bad) return { field: 'xml_content', error: bad };
    }
    return { value: { name, description, market, risk_level: risk, contract_type: contract || 'Other', xml_content: xml === '' ? undefined : xml } };
}

// A Deriv Bot file is Blockly XML. We only accept that shape, and refuse anything that could make an XML parser misbehave.
function checkBotXml(xml) {
    if (!xml.trim()) return 'The bot file is empty.';
    if (xml.length > LIMITS.botXml) return 'That bot file is too big (limit about 200 KB).';
    const head = xml.trimStart();
    if (!/^(<\?xml[^>]*\?>\s*)?<xml[\s>]/i.test(head) || !/<\/xml>\s*$/i.test(xml)) return 'That does not look like a Deriv Bot file. Export it from Deriv Bot as .xml and upload that.';
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return 'That bot file contains parts we cannot accept.';
    if (/<script|javascript:/i.test(xml)) return 'That bot file contains parts we cannot accept.';
    return '';
}

// ---------- strategy files ----------
function validateStrategy(body) {
    const title = clean(body.title, LIMITS.strategyTitle);
    const description = clean(body.description, LIMITS.strategyDescription);
    if (!title) return { field: 'title', error: 'Give the document a title.' };
    const fileName = clean(body.file_name, 200).replace(/[\\/]/g, '_');
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const type = FILE_TYPES[ext];
    if (!fileName || !type) return { field: 'file', error: 'Use a PDF, Word, Excel, PowerPoint, image (PNG or JPG) or text file.' };
    const b64 = String(body.file_base64 || '');
    if (!b64 || b64.length > Math.ceil(LIMITS.fileBytes * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
        return { field: 'file', error: `That file is empty, damaged or too big (limit ${Math.round(LIMITS.fileBytes / 1048576)} MB).` };
    }
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length || buffer.length > LIMITS.fileBytes) return { field: 'file', error: `That file is too big (limit ${Math.round(LIMITS.fileBytes / 1048576)} MB).` };
    if (!type.check(buffer)) return { field: 'file', error: `That file is not a real .${ext} file.` };
    const safeName = fileName.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.{2,}/g, '.').slice(0, 120);
    return { value: { title, description, file_name: safeName, mime: type.mime, buffer } };
}

// ---------- file storage (Vercel Blob) ----------
let blob = null;
const setBlob = impl => { blob = impl; };           // tests plug in a fake
const getBlob = () => blob || require('@vercel/blob');
const storageReady = () => !!blob || !!String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();

async function storeFile({ siteId, fileName, mime, buffer }) {
    const key = `strategies/${siteId}/${crypto.randomBytes(8).toString('hex')}-${fileName}`;
    const out = await getBlob().put(key, buffer, { access: 'public', contentType: mime, addRandomSuffix: false });
    return out.url;
}
// Best effort: a leftover file is harmless, a failed delete must not block removing a site.
async function purgeFiles(urls) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return;
    try { await getBlob().del(list); } catch (err) { console.error('blob delete failed:', err && err.message); }
}
const fileUrlsForSite = async (sql, siteId) => (await sql`SELECT blob_url FROM site_strategies WHERE site_id = ${siteId}`).map(r => r.blob_url);
const fileUrlsForOwner = async (sql, ownerId) => (await sql`SELECT blob_url FROM site_strategies WHERE owner_id = ${ownerId}`).map(r => r.blob_url);

// ---------- views ----------
const botView = r => ({
    id: r.id, name: r.name, description: r.description, market: r.market, risk_level: r.risk_level,
    contract_type: r.contract_type, status: r.status, removed_note: r.removed_note || '', created_at: r.created_at,
});
const strategyView = r => ({
    id: r.id, title: r.title, description: r.description, file_name: r.file_name, size_bytes: r.size_bytes,
    url: r.status === 'live' ? r.blob_url : '', status: r.status, removed_note: r.removed_note || '', created_at: r.created_at,
});
const requestView = r => ({ id: r.id, title: r.title, details: r.details, status: r.status, admin_note: r.admin_note || '', created_at: r.created_at, decided_at: r.decided_at });

async function operatorView(sql, ownerId) {
    const site = (await sql`SELECT id, name, domain, status FROM sites WHERE owner_id = ${ownerId} LIMIT 1`)[0] || null;
    const requests = await sql`SELECT id, title, details, status, admin_note, created_at, decided_at FROM bot_requests WHERE owner_id = ${ownerId} ORDER BY id DESC LIMIT 50`;
    if (!site) return { site: null, bots: [], strategies: [], requests: requests.map(requestView), limits: publicLimits(), storage_ready: storageReady() };
    const bots = await sql`SELECT id, name, description, market, risk_level, contract_type, status, removed_note, created_at FROM site_bots WHERE site_id = ${site.id} ORDER BY id DESC`;
    const strategies = await sql`SELECT id, title, description, file_name, size_bytes, blob_url, status, removed_note, created_at FROM site_strategies WHERE site_id = ${site.id} ORDER BY id DESC`;
    return {
        site: { id: site.id, name: site.name, domain: site.domain },
        bots: bots.map(botView), strategies: strategies.map(strategyView), requests: requests.map(requestView),
        limits: publicLimits(), storage_ready: storageReady(),
    };
}
const publicLimits = () => ({ file_mb: Math.round(LIMITS.fileBytes / 1048576), bots: LIMITS.botsPerSite, strategies: LIMITS.strategiesPerSite, open_requests: LIMITS.openRequests });

// What a site's visitors may see: live items of an ACTIVE site only. No owner details, never the XML in the list.
async function publicLibrary(sql, host) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!h) return null;
    const site = (await sql`SELECT id, name, domain FROM sites WHERE status = 'active' AND (domain = ${h} OR domain = ${'www.' + h}) LIMIT 1`)[0];
    if (!site) return null;
    const bots = await sql`SELECT id, name, description, market, risk_level, contract_type, created_at FROM site_bots WHERE site_id = ${site.id} AND status = 'live' ORDER BY id DESC`;
    const strategies = await sql`SELECT id, title, description, file_name, size_bytes, blob_url AS url, created_at FROM site_strategies WHERE site_id = ${site.id} AND status = 'live' ORDER BY id DESC`;
    return { site: { name: site.name, domain: site.domain }, bots, strategies };
}
async function publicBot(sql, host, id) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!h || !Number.isInteger(id)) return null;
    return (await sql`
        SELECT b.id, b.name, b.description, b.market, b.risk_level, b.contract_type, b.xml_content, b.created_at
        FROM site_bots b JOIN sites s ON s.id = b.site_id
        WHERE b.id = ${id} AND b.status = 'live' AND s.status = 'active' AND (s.domain = ${h} OR s.domain = ${'www.' + h}) LIMIT 1`)[0] || null;
}

async function adminView(sql) {
    const bots = await sql`
        SELECT b.id, b.name, b.market, b.risk_level, b.status, b.removed_note, b.created_at, s.domain AS site_domain, o.email AS owner_email
        FROM site_bots b JOIN sites s ON s.id = b.site_id JOIN owners o ON o.id = b.owner_id ORDER BY b.id DESC LIMIT 200`;
    const strategies = await sql`
        SELECT t.id, t.title, t.file_name, t.size_bytes, t.blob_url, t.status, t.removed_note, t.created_at, s.domain AS site_domain, o.email AS owner_email
        FROM site_strategies t JOIN sites s ON s.id = t.site_id JOIN owners o ON o.id = t.owner_id ORDER BY t.id DESC LIMIT 200`;
    const requests = await sql`
        SELECT r.id, r.title, r.details, r.status, r.admin_note, r.created_at, o.email AS owner_email, s.domain AS site_domain
        FROM bot_requests r JOIN owners o ON o.id = r.owner_id LEFT JOIN sites s ON s.id = r.site_id ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT 200`;
    return { bots, strategies, requests, storage_ready: storageReady() };
}

module.exports = {
    LIMITS, CONTRACT_TYPES, RISK_LEVELS, FILE_TYPES, clean,
    validateBot, checkBotXml, validateStrategy,
    setBlob, storageReady, storeFile, purgeFiles, fileUrlsForSite, fileUrlsForOwner,
    operatorView, publicLibrary, publicBot, adminView,
};
