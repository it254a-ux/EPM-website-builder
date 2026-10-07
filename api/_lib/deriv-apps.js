// OPTIONAL and OFF by default. Creates and updates the Deriv app of a site with an admin-scope token.
// It speaks Deriv's OLDER WebSocket API (authorize, then app_register / app_update). Deriv's current API
// (api.derivws.com) documents no way to create or change apps, so on the current platform apps are made in the
// Deriv dashboard and handed out from the App ID pool (api/_lib/app-pool.js). Switch this on only if Deriv
// confirms the older calls work for your account.
//
// Settings (Vercel environment variables):
//   DERIV_AUTO_CREATE   set to 1 to switch this on. Anything else = off, and the pool is used.
//   DERIV_ADMIN_TOKEN   required when on. A Deriv API token with the Admin scope. Never shown to anyone, never logged.
//   DERIV_REDIRECT_URI  required for free sites: the login return address of your main site (copy the Authorisation URL of your existing app).
//   DERIV_REDIRECT_PATH optional, default "/": path appended to a custom domain, e.g. "/callback".
//   DERIV_APP_SCOPES    optional, default "read,trade,trading_information".
//   DERIV_WS_URL        optional, default wss://ws.derivws.com/websockets/v3.
//   DERIV_WS_APP_ID     optional, default 1089: the app id used only to open the socket.

const DEFAULT_WS = 'wss://ws.derivws.com/websockets/v3';
const ALLOWED_SCOPES = ['read', 'trade', 'trading_information', 'payments', 'admin'];
const TIMEOUT_MS = 7000;

class DerivError extends Error {
    constructor(message, code) { super(message); this.name = 'DerivError'; this.code = code || 'deriv_error'; }
}

const env = k => String(process.env[k] || '').trim();

function settings() {
    const scopes = (env('DERIV_APP_SCOPES') || 'read,trade,trading_information').split(',').map(s => s.trim()).filter(s => ALLOWED_SCOPES.includes(s));
    return {
        token: env('DERIV_ADMIN_TOKEN'),
        wsUrl: env('DERIV_WS_URL') || DEFAULT_WS,
        connectAppId: env('DERIV_WS_APP_ID') || '1089',
        scopes: [...new Set(scopes.length ? scopes : ['read', 'trade', 'trading_information'])],
        redirectFree: env('DERIV_REDIRECT_URI'),
        redirectPath: env('DERIV_REDIRECT_PATH') || '/',
    };
}

const isConfigured = () => !!settings().token;
// On only when you ask for it (DERIV_AUTO_CREATE=1) AND a token exists.
const isEnabled = () => isConfigured() && env('DERIV_AUTO_CREATE') === '1';

// What is missing, in words the admin panel can show.
function missingSettings() {
    const s = settings(), out = [];
    if (!s.token) out.push('DERIV_ADMIN_TOKEN');
    if (!s.redirectFree) out.push('DERIV_REDIRECT_URI');
    return out;
}

// Deriv app names: letters, numbers, spaces, hyphens, up to 48 characters. The site id keeps every name unique.
function appName(site) {
    const suffix = ` EPM-${site.id}`;
    const base = String(site.name || '').replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim() || 'Site';
    return (base.slice(0, 48 - suffix.length).trim() + suffix).slice(0, 48);
}

// Where Deriv sends a client after login. Free sites come back through your main domain; custom domains use their own.
function redirectFor(site) {
    const s = settings();
    if (site.plan === 'custom') {
        const path = s.redirectPath.startsWith('/') ? s.redirectPath : `/${s.redirectPath}`;
        return `https://${site.domain}${path}`;
    }
    return s.redirectFree;
}

const homepageFor = site => `https://${site.domain}`;

const markupNumber = m => Math.round(Number(m) * 100) / 100;

// ---------- transport ----------
function openSocket(url) {
    const WS = globalThis.WebSocket || require('ws');
    return new WS(url);
}

// Sends messages one after another on one socket and returns the reply to each. Replaceable in tests.
function defaultTransport(messages, { timeoutMs = TIMEOUT_MS } = {}) {
    const s = settings();
    const url = `${s.wsUrl}${s.wsUrl.includes('?') ? '&' : '?'}app_id=${encodeURIComponent(s.connectAppId)}`;
    return new Promise((resolve, reject) => {
        let socket, finished = false, index = 0;
        const replies = [];
        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            try { socket && socket.close(); } catch (e) { /* already closed */ }
            if (err) reject(err); else resolve(value);
        };
        const timer = setTimeout(() => done(new DerivError('Deriv did not answer in time.', 'timeout')), timeoutMs);
        const on = (name, fn) => (socket.addEventListener ? socket.addEventListener(name, fn) : socket.on(name, fn));
        try { socket = openSocket(url); } catch (e) { return done(new DerivError('Could not reach Deriv.', 'connect')); }
        on('open', () => socket.send(JSON.stringify(messages[0])));
        on('error', () => done(new DerivError('Could not reach Deriv.', 'connect')));
        on('close', () => done(new DerivError('Deriv closed the connection.', 'closed')));
        on('message', ev => {
            let data;
            try { data = JSON.parse(typeof ev === 'string' || Buffer.isBuffer(ev) ? String(ev) : ev.data); } catch (e) { return done(new DerivError('Deriv sent an unreadable answer.', 'bad_reply')); }
            if (data.error) return done(new DerivError(String(data.error.message || 'Deriv refused the request.').slice(0, 300), data.error.code || 'deriv_error'));
            replies.push(data);
            index += 1;
            if (index >= messages.length) return done(null, replies);
            socket.send(JSON.stringify(messages[index]));
        });
    });
}

let transport = defaultTransport;
const setTransport = fn => { transport = fn || defaultTransport; };

// Authorize with the admin token, then run one call. Returns that call's reply.
async function run(message) {
    const s = settings();
    if (!s.token) throw new DerivError('DERIV_ADMIN_TOKEN is not set.', 'not_configured');
    const replies = await transport([{ authorize: s.token }, message]);
    return replies[replies.length - 1];
}

// ---------- calls ----------
// Registers a new app for a site. Returns its App ID as text.
async function registerApp(site) {
    const s = settings();
    const redirect = redirectFor(site);
    if (!redirect) throw new DerivError('DERIV_REDIRECT_URI is not set.', 'not_configured');
    const reply = await run({
        app_register: 1,
        name: appName(site),
        scopes: s.scopes,
        app_markup_percentage: markupNumber(site.markup_percent),
        redirect_uri: redirect,
        homepage: homepageFor(site),
    });
    const id = reply && reply.app_register && reply.app_register.app_id;
    if (id === undefined || id === null || !/^[A-Za-z0-9]{1,40}$/.test(String(id))) throw new DerivError('Deriv did not return an App ID.', 'bad_reply');
    return String(id);
}

// Changes the markup and/or redirect of an app we created. Needs the full site (name and redirect are required by Deriv).
async function updateApp(appId, site) {
    const s = settings();
    if (!/^\d+$/.test(String(appId))) throw new DerivError('This App ID was not created through the API.', 'not_api_app');
    const redirect = redirectFor(site);
    if (!redirect) throw new DerivError('DERIV_REDIRECT_URI is not set.', 'not_configured');
    await run({
        app_update: Number(appId),
        name: appName(site),
        scopes: s.scopes,
        app_markup_percentage: markupNumber(site.markup_percent),
        redirect_uri: redirect,
        homepage: homepageFor(site),
    });
}

// Is the token valid and does it have the Admin scope? Used by the admin panel's "Test connection".
async function checkConnection() {
    const s = settings();
    if (!s.token) throw new DerivError('DERIV_ADMIN_TOKEN is not set.', 'not_configured');
    const replies = await transport([{ authorize: s.token }]);
    const a = (replies[0] && replies[0].authorize) || {};
    const scopes = Array.isArray(a.scopes) ? a.scopes : [];
    return { ok: scopes.includes('admin'), scopes, loginid: a.loginid || '' };
}

module.exports = { DerivError, isConfigured, isEnabled, missingSettings, settings, appName, redirectFor, registerApp, updateApp, checkConnection, setTransport, defaultTransport };
