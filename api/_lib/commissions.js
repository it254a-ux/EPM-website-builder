// Earnings ledger for operators.
//
// Deriv's markup statistics (GET /applications/v1/markup-statistics) return one row per app for the dates asked for.
// We ask for one UTC day at a time, match each app to a site through sites.app_id, and store the operator's part
// (markup x the operator's share) in commission_daily. Operators only ever see their own part in US dollars:
// never the markup, the volume or either share.
//
// Money rules:
//   - A month becomes "confirmed" when the admin records that Deriv has paid it. Only confirmed earnings can be withdrawn.
//   - Days of a confirmed month are frozen: a later sync never changes them, so a balance can never drop below what was paid out.
//   - One open withdrawal request per operator, never more than the available balance.
//
// Settings (Vercel environment variables):
//   DERIV_STATS_TOKEN   token with the application_read scope. Never shown to anyone, never logged.
//   DERIV_STATS_APP_ID  the App ID Deriv wants sent with a personal token (header Deriv-App-ID). Optional.
//   DERIV_API_BASE      default https://api.derivws.com
//   WITHDRAWAL_MIN_USD  smallest withdrawal, default 10
const S = require('./site-settings');

const env = k => String(process.env[k] || '').trim();
const STATS_PATH = '/applications/v1/markup-statistics';
const TIMEOUT_MS = 15000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const NETWORKS = ['TRC20', 'ERC20', 'BEP20'];

class CommissionError extends Error {
    constructor(message, code) { super(message); this.name = 'CommissionError'; this.code = code || 'commission_error'; }
}

const settings = () => ({
    token: env('DERIV_STATS_TOKEN'),
    appId: env('DERIV_STATS_APP_ID'),
    base: (env('DERIV_API_BASE') || 'https://api.derivws.com').replace(/\/+$/, ''),
});
const isConfigured = () => !!settings().token;

const minWithdrawal = () => {
    const n = Number(env('WITHDRAWAL_MIN_USD'));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 10;
};

// Replaceable in tests.
let fetchImpl = null;
const setFetch = fn => { fetchImpl = fn || null; };

// ---------- dates (all UTC) ----------
const isValidDay = s => {
    if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isValidMonth = s => typeof s === 'string' && MONTH_RE.test(s);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const daysInMonth = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cents = v => Math.round(num(v) * 100) / 100;
const floorCents = v => Math.floor(num(v) * 100 + 1e-6) / 100; // never round a balance UP

// ---------- Deriv ----------
// One UTC day of markup statistics -> [{ app_id, markup, volume, contracts, clients }]
async function fetchDay(day) {
    const s = settings();
    if (!s.token) throw new CommissionError('DERIV_STATS_TOKEN is not set.', 'not_configured');
    if (!isValidDay(day)) throw new CommissionError('Not a valid date.', 'bad_day');
    const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/json' };
    if (s.appId) headers['Deriv-App-ID'] = s.appId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
        res = await (fetchImpl || fetch)(`${s.base}${STATS_PATH}?date_from=${day}&date_to=${day}`, { headers, signal: ctrl.signal });
    } catch (err) {
        throw new CommissionError(err && err.name === 'AbortError' ? 'Deriv did not answer in time.' : 'Could not reach Deriv.', 'network');
    } finally {
        clearTimeout(timer);
    }
    let json = null;
    try { json = await res.json(); } catch (err) { /* not JSON */ }
    if (!res.ok) {
        const m = json && json.errors && json.errors[0] && json.errors[0].message;
        throw new CommissionError(`Deriv said ${res.status}${m ? `: ${String(m).replace(/[\r\n]+/g, ' ').slice(0, 150)}` : ''}`, `http_${res.status}`);
    }
    const rows = json && json.data && json.data.breakdown;
    if (!Array.isArray(rows)) throw new CommissionError('Deriv sent an answer we did not expect.', 'bad_reply');
    return rows
        .map(r => ({
            app_id: String((r && r.app_id) || ''),
            markup: Number(r && r.app_markup_usd),
            volume: num(r && r.volume_usd),
            contracts: Math.trunc(num(r && r.contract_count)),
            clients: Math.trunc(num(r && r.client_count)),
        }))
        .filter(r => /^[A-Za-z0-9]{1,40}$/.test(r.app_id) && Number.isFinite(r.markup) && r.markup >= 0);
}

// The % the platform kept on that day (the rate in force then), falling back to the current effective rate.
async function shareFor(sql, site, day) {
    const h = (await sql`
        SELECT platform_share FROM site_rate_history
        WHERE site_id = ${site.id} AND effective_from < (${day}::date + 1)
        ORDER BY effective_from DESC, id DESC LIMIT 1`)[0];
    if (h) return num(h.platform_share);
    if (site.commission_rate_override !== null && site.commission_rate_override !== undefined) return num(site.commission_rate_override);
    return S.PLAN_SHARE[site.plan] === undefined ? S.PLAN_SHARE.custom : S.PLAN_SHARE[site.plan];
}

// Reads one day from Deriv and stores it. Safe to run again for the same day (it replaces that day's rows).
async function syncDay(sql, day) {
    const rows = await fetchDay(day);
    const out = { day, apps: rows.length, matched: 0, unmatched: 0, locked: false };
    if ((await sql`SELECT 1 FROM commission_months WHERE month = ${day.slice(0, 7)}`).length) { out.locked = true; return out; }
    for (const r of rows) {
        const site = (await sql`SELECT id, owner_id, plan, commission_rate_override FROM sites WHERE app_id = ${r.app_id} LIMIT 1`)[0];
        if (!site || !site.owner_id) { out.unmatched += 1; continue; } // not one of your operators' apps (for example your own trading site)
        const share = await shareFor(sql, site, day);
        const ownerUsd = Math.round(r.markup * (100 - share) * 100) / 10000;
        await sql`
            INSERT INTO commission_daily (app_id, day, site_id, owner_id, markup_usd, volume_usd, contracts, clients, platform_share, owner_usd, synced_at)
            VALUES (${r.app_id}, ${day}::date, ${site.id}, ${site.owner_id}, ${r.markup}, ${r.volume}, ${r.contracts}, ${r.clients}, ${share}, ${ownerUsd}, now())
            ON CONFLICT (app_id, day) DO UPDATE SET
                site_id = EXCLUDED.site_id, owner_id = EXCLUDED.owner_id, markup_usd = EXCLUDED.markup_usd, volume_usd = EXCLUDED.volume_usd,
                contracts = EXCLUDED.contracts, clients = EXCLUDED.clients, platform_share = EXCLUDED.platform_share,
                owner_usd = EXCLUDED.owner_usd, synced_at = now()`;
        out.matched += 1;
    }
    return out;
}

// Syncs a run of days, oldest first. Stops at the first failure and says where.
async function syncRange(sql, from, to) {
    const results = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
        try { results.push(await syncDay(sql, d)); }
        catch (err) { results.push({ day: d, error: String(err && err.message || 'failed').slice(0, 200) }); break; }
    }
    return results;
}

// ---------- balances ----------
async function balances(sql, ownerId) {
    const [e, w] = await Promise.all([
        sql`
        SELECT COALESCE(SUM(c.owner_usd) FILTER (WHERE m.month IS NOT NULL), 0) AS confirmed,
               COALESCE(SUM(c.owner_usd) FILTER (WHERE m.month IS NULL), 0) AS pending
        FROM commission_daily c LEFT JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM')
        WHERE c.owner_id = ${ownerId}`.then(r => r[0]),
        sql`
        SELECT COALESCE(SUM(amount_usd) FILTER (WHERE status = 'requested'), 0) AS requested,
               COALESCE(SUM(amount_usd) FILTER (WHERE status = 'paid'), 0) AS paid
        FROM payout_requests WHERE owner_id = ${ownerId}`.then(r => r[0]),
    ]);
    const confirmed = num(e.confirmed), requested = num(w.requested), paid = num(w.paid);
    return {
        confirmed, pending: num(e.pending), requested, paid,
        available: Math.max(0, floorCents(confirmed - requested - paid)),
    };
}

// Why an account may not be deleted yet (money would be lost), or '' if it is fine.
async function deleteBlocker(sql, ownerId) {
    if ((await sql`SELECT 1 FROM payout_requests WHERE owner_id = ${ownerId} AND status = 'requested' LIMIT 1`).length) return 'a withdrawal request is still waiting';
    const b = await balances(sql, ownerId);
    if (b.available >= 0.01) return 'there are earnings waiting to be paid out';
    if (b.pending >= 0.01) return 'there are earnings still waiting for Deriv’s monthly payment';
    return '';
}

// ---------- what an operator may see ----------
const maskDestination = d => {
    const s = String(d || '');
    return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
};

async function operatorView(sql, ownerId) {
    const month = todayUtc().slice(0, 7);
    // All the reads run at the same time: one round trip's wait instead of eight.
    const [b, last, thisMonth, synced, days, months, requests] = await Promise.all([
        balances(sql, ownerId),
        sql`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(owner_usd) AS usd FROM commission_daily
        WHERE owner_id = ${ownerId} GROUP BY day ORDER BY day DESC LIMIT 1`.then(r => r[0]),
        sql`
        SELECT COALESCE(SUM(owner_usd), 0) AS usd FROM commission_daily
        WHERE owner_id = ${ownerId} AND to_char(day, 'YYYY-MM') = ${month}`.then(r => r[0]),
        sql`SELECT max(synced_at) AS t FROM commission_daily WHERE owner_id = ${ownerId}`.then(r => r[0]),
        sql`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(owner_usd) AS usd FROM commission_daily
        WHERE owner_id = ${ownerId} GROUP BY day ORDER BY day DESC LIMIT 90`,
        sql`
        SELECT to_char(c.day, 'YYYY-MM') AS month, SUM(c.owner_usd) AS usd, (m.month IS NOT NULL) AS confirmed
        FROM commission_daily c LEFT JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM')
        WHERE c.owner_id = ${ownerId} GROUP BY 1, m.month ORDER BY 1 DESC LIMIT 24`,
        sql`
        SELECT id, amount_usd, method, network, destination, status, reference, note, created_at, decided_at
        FROM payout_requests WHERE owner_id = ${ownerId} ORDER BY id DESC LIMIT 50`,
    ]);
    return {
        min_withdrawal: minWithdrawal(),
        summary: {
            available: b.available, pending: cents(b.pending), requested: cents(b.requested), paid: cents(b.paid),
            this_month: cents(thisMonth.usd), this_month_label: month,
            latest_day: last ? last.day : null, latest_day_amount: last ? cents(last.usd) : 0,
            last_updated: synced && synced.t ? synced.t : null,
        },
        days: days.map(d => ({ day: d.day, amount: cents(d.usd) })),
        months: months.map(m => ({ month: m.month, amount: cents(m.usd), confirmed: !!m.confirmed })),
        requests: requests.map(r => ({
            id: r.id, amount: cents(r.amount_usd), method: r.method, network: r.network || '', destination: maskDestination(r.destination),
            status: r.status, reference: r.reference || '', note: r.note || '', created_at: r.created_at, decided_at: r.decided_at,
        })),
    };
}

// ---------- withdrawals ----------
function normalizePhone(v) {
    let s = String(v || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
    if (/^0[17]\d{8}$/.test(s)) s = `254${s.slice(1)}`;
    else if (/^[17]\d{8}$/.test(s)) s = `254${s}`;
    return /^254[17]\d{8}$/.test(s) ? s : '';
}
function normalizeWallet(address, network) {
    const s = String(address || '').trim();
    if (network === 'TRC20') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s) ? s : '';
    return /^0x[a-fA-F0-9]{40}$/.test(s) ? s : '';
}

// -> { value } or { error, field }
function validateWithdrawal(body) {
    const raw = String(body && body.amount !== undefined ? body.amount : '').trim();
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) return { error: 'Enter an amount in US dollars, for example 25 or 25.50.', field: 'amount' };
    const amount = cents(raw), min = minWithdrawal();
    if (amount < min) return { error: `The smallest withdrawal is $${min.toFixed(2)}.`, field: 'amount' };
    const method = body.method;
    if (method === 'mpesa') {
        const phone = normalizePhone(body.destination);
        if (!phone) return { error: 'Enter a Safaricom number such as 0712 345 678.', field: 'destination' };
        return { value: { amount, method, network: null, destination: phone } };
    }
    if (method === 'usdt') {
        const network = String(body.network || '').toUpperCase();
        if (!NETWORKS.includes(network)) return { error: 'Choose the network: TRC20, ERC20 or BEP20.', field: 'network' };
        const wallet = normalizeWallet(body.destination, network);
        if (!wallet) return { error: `That is not a valid ${network} wallet address.`, field: 'destination' };
        return { value: { amount, method, network, destination: wallet } };
    }
    return { error: 'Choose M-Pesa or USDT.', field: 'method' };
}

// One statement, so the balance check and the insert cannot be separated.
async function createWithdrawal(sql, ownerId, v) {
    const rows = await sql`
        INSERT INTO payout_requests (owner_id, amount_usd, method, network, destination)
        SELECT ${ownerId}::int, ${v.amount}::numeric, ${v.method}::text, ${v.network}::text, ${v.destination}::text
        WHERE ${v.amount}::numeric <= (
            COALESCE((SELECT SUM(c.owner_usd) FROM commission_daily c JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM') WHERE c.owner_id = ${ownerId}::int), 0)
          - COALESCE((SELECT SUM(p.amount_usd) FROM payout_requests p WHERE p.owner_id = ${ownerId}::int AND p.status IN ('requested', 'paid')), 0))
        RETURNING id`;
    return rows.length ? rows[0].id : null;
}

// ---------- what the admin sees ----------
async function adminView(sql) {
    const [months, requests, synced] = await Promise.all([sql`
        SELECT to_char(c.day, 'YYYY-MM') AS month, count(DISTINCT c.day)::int AS days_synced,
               SUM(c.markup_usd) AS markup, SUM(c.owner_usd) AS owner_usd, (m.month IS NOT NULL) AS confirmed
        FROM commission_daily c LEFT JOIN commission_months m ON m.month = to_char(c.day, 'YYYY-MM')
        GROUP BY 1, m.month ORDER BY 1 DESC LIMIT 12`,
    sql`
        SELECT p.id, p.owner_id, p.amount_usd, p.method, p.network, p.destination, p.status, p.reference, p.note, p.created_at, p.decided_at,
               o.email AS owner_email, o.name AS owner_name, s.domain AS site_domain
        FROM payout_requests p LEFT JOIN owners o ON o.id = p.owner_id LEFT JOIN sites s ON s.owner_id = p.owner_id
        ORDER BY (p.status = 'requested') DESC, p.id DESC LIMIT 60`,
    sql`SELECT max(synced_at) AS t FROM commission_daily`.then(r => r[0])]);
    return {
        configured: isConfigured(),
        last_synced: synced && synced.t ? synced.t : null,
        months: months.map(m => ({
            month: m.month, days_synced: m.days_synced, days_in_month: daysInMonth(m.month),
            markup_usd: cents(m.markup), owner_usd: cents(m.owner_usd), platform_usd: cents(num(m.markup) - num(m.owner_usd)), confirmed: !!m.confirmed,
        })),
        requests: requests.map(r => ({ ...r, amount_usd: cents(r.amount_usd) })),
    };
}

module.exports = {
    CommissionError, NETWORKS, isConfigured, settings, minWithdrawal, setFetch,
    isValidDay, isValidMonth, todayUtc, addDays, daysInMonth,
    fetchDay, syncDay, syncRange, balances, deleteBlocker, operatorView, adminView,
    validateWithdrawal, createWithdrawal, normalizePhone, normalizeWallet, maskDestination,
};
