const { getDb } = require('./_lib/db');
const L = require('./_lib/library');
const S = require('./_lib/site-settings');

// PUBLIC, read-only. What visitors of one operator site may see: that site's live bots and strategy documents.
//   GET /api/site-library?host=name.example.com          -> { site, bots[], strategies[] }   (no bot files in the list)
//   GET /api/site-library?host=name.example.com&id=12    -> { bot }  including the bot file, used when a visitor loads it
// Nothing about the owner is ever returned. Suspended or waiting sites return 404.
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    try {
        const host = S.normalizeHost(req.query.host || '');
        if (!host) return res.status(400).json({ error: 'host is required' });
        const sql = getDb();
        if (req.query.id !== undefined) {
            res.setHeader('Cache-Control', 'no-store');
            const bot = await L.publicBot(sql, host, Number(req.query.id));
            return bot ? res.status(200).json({ bot }) : res.status(404).json({ error: 'Bot not found' });
        }
        const lib = await L.publicLibrary(sql, host);
        return lib ? res.status(200).json(lib) : res.status(404).json({ error: 'Site not found' });
    } catch (err) {
        console.error('site-library error:', err);
        return res.status(500).json({ error: 'Something went wrong.' });
    }
};
