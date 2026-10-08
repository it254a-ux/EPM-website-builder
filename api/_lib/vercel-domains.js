// Adds an operator's own domain to the Vercel project that serves the operator sites, so you no longer do it by hand.
// Uses Vercel's REST API: POST /v10/projects/{project}/domains  (docs: vercel.com/docs/rest-api/projects/add-a-domain-to-a-project).
// UNTESTED against live Vercel: the first real approval is the real test.
//
// Settings (Vercel environment variables). All three are optional; without the first two this does nothing and you add domains by hand as before.
//   DOMAINS_VERCEL_TOKEN    a Vercel access token that may edit that project. Paste it in Vercel only, never in chat, never in code.
//   DOMAINS_VERCEL_PROJECT  the name or ID of the Vercel project that SERVES the operator sites (the one the DNS records point at).
//   DOMAINS_VERCEL_TEAM     only if the project belongs to a team: the team ID (starts with team_).
//   DOMAINS_VERCEL_API      optional, default https://api.vercel.com.
//
// addDomain() never throws and never returns the token. It answers { status, message }:
//   off | added | already_added | needs_verification | conflict | failed

const DEFAULT_API = 'https://api.vercel.com';
const TIMEOUT_MS = 8000;

const env = k => String(process.env[k] || '').trim();

function settings() {
    return {
        token: env('DOMAINS_VERCEL_TOKEN'),
        project: env('DOMAINS_VERCEL_PROJECT'),
        team: env('DOMAINS_VERCEL_TEAM'),
        base: (env('DOMAINS_VERCEL_API') || DEFAULT_API).replace(/\/+$/, ''),
    };
}

const isConfigured = () => { const s = settings(); return !!(s.token && s.project); };

// What is missing, in words the admin panel can show.
function missingSettings() {
    const s = settings(), out = [];
    if (!s.token) out.push('DOMAINS_VERCEL_TOKEN');
    if (!s.project) out.push('DOMAINS_VERCEL_PROJECT');
    return out;
}

// Real network call, replaced by a fake in tests. Returns { status, body } and throws only on network failure or timeout.
async function defaultTransport(url, options) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...options, signal: ctl.signal });
        let body = null;
        try { body = await r.json(); } catch (e) { /* no JSON body */ }
        return { status: r.status, body };
    } finally { clearTimeout(timer); }
}
let transport = defaultTransport;
const setTransport = fn => { transport = fn || defaultTransport; };

const VALID_DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Short, safe text: no line breaks, no long dumps.
const clean = t => String(t || '').replace(/[\r\n]+/g, ' ').slice(0, 160);

async function addDomain(domain) {
    if (!isConfigured()) return { status: 'off', message: 'The Vercel connection is not set up, so add this domain to the Vercel project yourself.' };
    const name = String(domain || '').trim().toLowerCase();
    if (!VALID_DOMAIN.test(name)) return { status: 'failed', message: 'That does not look like a valid domain.' };

    const s = settings();
    const url = `${s.base}/v10/projects/${encodeURIComponent(s.project)}/domains` + (s.team ? `?teamId=${encodeURIComponent(s.team)}` : '');
    let res;
    try {
        res = await transport(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    } catch (err) {
        return { status: 'failed', message: 'Could not reach Vercel. Try again in a minute.' };
    }

    const status = res && res.status;
    const apiError = (res && res.body && res.body.error) || {};
    const apiMessage = clean(apiError.message);

    if (status === 200 || status === 201) {
        if (res.body && res.body.verified === false) {
            return { status: 'needs_verification', message: `Vercel added ${name} but needs to verify it first. Open the project in Vercel, then Settings, Domains, and follow the steps shown for it.` };
        }
        return { status: 'added', message: `${name} was added to the Vercel project.` };
    }
    if (status === 409) return { status: 'conflict', message: `Vercel says ${name} already belongs to another project or account. Remove it there first, or add it by hand.` };
    if (status === 400 && /already/i.test(apiMessage)) return { status: 'already_added', message: `${name} was already on the Vercel project.` };
    if (status === 401 || status === 403) return { status: 'failed', message: 'Vercel refused the token. Check DOMAINS_VERCEL_TOKEN, that it can edit this project, and DOMAINS_VERCEL_TEAM if the project is in a team.' };
    if (status === 404) return { status: 'failed', message: 'Vercel could not find the project. Check DOMAINS_VERCEL_PROJECT (and DOMAINS_VERCEL_TEAM if it is in a team).' };
    return { status: 'failed', message: `Vercel answered with an error (${status || 'no reply'})${apiMessage ? ': ' + apiMessage : ''}.` };
}

module.exports = { isConfigured, missingSettings, settings, addDomain, setTransport, defaultTransport, VALID_DOMAIN };
