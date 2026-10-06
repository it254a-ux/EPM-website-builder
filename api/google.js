const crypto = require('crypto');
const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');

// "Continue with Google": standard server-side OpenID Connect (authorization code) flow.
//
//   GET /api/google?start=1&terms=1|0   -> sends the browser to Google
//   GET /api/google?code=..&state=..    -> Google sends the browser back here; we sign the person in
//
// Google accounts have no password (password_hash = 'google'). Only Google accounts whose
// email Google has VERIFIED are accepted. Admin accounts can never sign in this way.
const TERMS_VERSION = '2026-10-04';
const COOKIE = 'epm_oauth';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const b64u = v => Buffer.from(v).toString('base64url');
function sign(payload, key) {
    const body = b64u(JSON.stringify(payload));
    return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
}
function unsign(token, key) {
    try {
        const [body, mac] = String(token || '').split('.');
        const want = crypto.createHmac('sha256', key).update(body).digest();
        const got = Buffer.from(mac || '', 'base64url');
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}
function decodeJwt(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

const redirect = (res, location, cookies) => {
    if (cookies && cookies.length) res.setHeader('Set-Cookie', cookies);
    res.statusCode = 302;
    res.setHeader('Location', location);
    res.end();
};
const oauthCookie = (req, value, maxAge) =>
    [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/api/google', `Max-Age=${maxAge}`, ...(A.isSecureRequest(req) ? ['Secure'] : [])].join('; ');

function redirectUri(req) {
    if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
    const host = A.requestHost(req);
    const local = host === 'localhost' || host === '127.0.0.1';
    return `${local ? 'http' : 'https'}://${host}${local && req.headers.host && req.headers.host.includes(':') ? ':' + req.headers.host.split(':')[1] : ''}/api/google`;
}

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!A.onPlatformHost(req, 'open')) { res.statusCode = 404; return res.end(); }
    if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }

    const clientId = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !secret) return redirect(res, '/app/?google=unavailable');

    const sql = getDb();
    const q = req.query || {};
    try {
        if ((await A.hit(sql, `google:ip:${A.clientIp(req)}`, 600)) > 40) return redirect(res, '/app/?google=error');

        // ---------- step 1: send the person to Google ----------
        if (q.start) {
            const state = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
            const cookie = sign({ s: state, n: nonce, t: q.terms === '1' ? 1 : 0, e: Date.now() + 10 * 60 * 1000 }, secret);
            const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            url.search = new URLSearchParams({
                client_id: clientId, redirect_uri: redirectUri(req), response_type: 'code',
                scope: 'openid email profile', state, nonce, prompt: 'select_account',
            }).toString();
            return redirect(res, url.toString(), [oauthCookie(req, cookie, 600)]);
        }

        // ---------- step 2: Google sent them back ----------
        if (q.code || q.error) {
            const clear = oauthCookie(req, '', 0);
            if (q.error) return redirect(res, '/app/?google=denied', [clear]);
            const flow = unsign(A.parseCookies(req.headers.cookie)[COOKIE], secret);
            if (!flow || flow.e < Date.now() || typeof q.state !== 'string' || flow.s !== q.state) return redirect(res, '/app/?google=error', [clear]);

            let tokens;
            try {
                const r = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ code: String(q.code), client_id: clientId, client_secret: secret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
                    signal: AbortSignal.timeout(10000),
                });
                if (!r.ok) throw new Error(`token ${r.status}`);
                tokens = await r.json();
            } catch (err) {
                console.error('google token error:', err.message);
                return redirect(res, '/app/?google=error', [clear]);
            }

            const c = decodeJwt(tokens && tokens.id_token);
            const now = Math.floor(Date.now() / 1000);
            const verified = c && (c.email_verified === true || c.email_verified === 'true');
            if (!c || !ISSUERS.includes(c.iss) || c.aud !== clientId || !(c.exp > now) || c.nonce !== flow.n || !verified) {
                return redirect(res, '/app/?google=error', [clear]);
            }
            const email = A.validateEmail(c.email);
            if (!email) return redirect(res, '/app/?google=error', [clear]);
            const name = (String(c.name || '').trim().replace(/[<>]/g, '').slice(0, 80)) || email.split('@')[0];

            let owner = (await sql`SELECT id, email, name, role, disabled, password_hash FROM owners WHERE email = ${email} LIMIT 1`)[0];
            if (owner) {
                if (owner.disabled) return redirect(res, '/app/?google=disabled', [clear]);
                if (owner.role !== 'operator') return redirect(res, '/app/?google=admin', [clear]);
                if (String(owner.password_hash).startsWith('scrypt$')) {
                    // The email was never verified when this password account was made, so the Google owner of
                    // this address takes it over: password sign-in is switched off and old sessions are ended.
                    await sql`UPDATE owners SET password_hash = 'google' WHERE id = ${owner.id}`;
                    await sql`DELETE FROM sessions WHERE owner_id = ${owner.id}`;
                    await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${owner.id}, 'google_linked', ${email}, '{}'::jsonb)`;
                }
            } else {
                if (!flow.t) return redirect(res, '/app/?google=terms', [clear]);
                try {
                    owner = (await sql`INSERT INTO owners (email, name, password_hash, role) VALUES (${email}, ${name}, 'google', 'operator') RETURNING id`)[0];
                } catch (err) {
                    if (err && err.code === '23505') return redirect(res, '/app/?google=error', [clear]);
                    throw err;
                }
                await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${owner.id}, 'terms_accepted', ${email}, ${JSON.stringify({ version: TERMS_VERSION, via: 'google' })}::jsonb)`;
            }

            const token = await A.createSession(sql, owner.id);
            return redirect(res, '/app/', [clear, A.sessionCookie(req, token, A.SESSION_DAYS * 86400)]);
        }

        return redirect(res, '/app/');
    } catch (err) {
        console.error('google error:', err);
        return redirect(res, '/app/?google=error');
    }
};
