// Authentication helpers (CommonJS, no extra dependencies -- Node's crypto only).
//
// - Passwords: scrypt with a per-password random salt (never stored in plain text).
// - Sessions: a random 32-byte token in an HttpOnly cookie; only its SHA-256 hash is
//   stored in the database, so a database leak does not hand out working sessions.
// - Rate limiting: counted in the database, so it works across serverless instances.
const crypto = require('crypto');
const { normalizeHost, parsePlatformHosts, isLocalHost } = require('./site-settings');

const COOKIE_NAME = 'epm_session';
const SESSION_DAYS = 14;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ---------- passwords ----------
const scrypt = (password, salt, opts) =>
    new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p }, (err, key) =>
            err ? reject(err) : resolve(key)
        )
    );

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
    try {
        const [kind, N, r, p, saltB64, keyB64] = String(stored || '').split('$');
        if (kind !== 'scrypt') return false;
        const expected = Buffer.from(keyB64, 'base64');
        const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), {
            N: Number(N), r: Number(r), p: Number(p), keylen: expected.length,
        });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

// A real hash of a random value, used so "unknown email" takes as long as "wrong password".
let dummyHashPromise;
const dummyVerify = async password => {
    dummyHashPromise = dummyHashPromise || hashPassword(crypto.randomBytes(16).toString('hex'));
    return verifyPassword(password, await dummyHashPromise);
};

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200; // caps hashing cost so huge inputs can't be used to slow the server

function validatePassword(password, email) {
    if (typeof password !== 'string') return 'Password is required.';
    if (password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
    if (password.length > MAX_PASSWORD) return 'That password is too long.';
    if (email && password.toLowerCase() === String(email).toLowerCase()) return 'Password cannot be your email.';
    if (/^(.)\1+$/.test(password)) return 'Choose a less repetitive password.';
    return '';
}

const validateEmail = v => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return s.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s) ? s : '';
};

// ---------- tokens & cookies ----------
const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

const isSecureRequest = req =>
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    process.env.NODE_ENV === 'production';

function sessionCookie(req, token, maxAgeSeconds) {
    const parts = [
        `${COOKIE_NAME}=${token}`,
        'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`,
    ];
    if (isSecureRequest(req)) parts.push('Secure');
    return parts.join('; ');
}

const clearCookie = req => sessionCookie(req, '', 0);

// ---------- request guards ----------
const requestHost = req => normalizeHost(req.headers['x-forwarded-host'] || req.headers.host);

// Is this request arriving on one of YOUR domains?
//  mode 'open'   : legacy-friendly -- if PLATFORM_HOSTS is unset, allow (today's behaviour)
//  mode 'strict' : fail closed -- if PLATFORM_HOSTS is unset, refuse (used for admin)
function onPlatformHost(req, mode = 'open') {
    const hosts = parsePlatformHosts(process.env.PLATFORM_HOSTS);
    const host = requestHost(req);
    if (hosts.length === 0) return mode === 'open';
    return hosts.includes(host) || isLocalHost(host);
}

// Blocks cross-site form posts: for state-changing requests the Origin (when sent)
// must be the same host we are serving.
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients / same-origin GETs
    try {
        return normalizeHost(new URL(origin).host) === requestHost(req);
    } catch {
        return false;
    }
}

const clientIp = req =>
    String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

// Counts a hit for `key`; returns the count inside the current window.
async function hit(sql, key, windowSeconds) {
    const rows = await sql`
        INSERT INTO auth_attempts (key, count, window_start)
        VALUES (${key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN auth_attempts.window_start < now() - (${windowSeconds}::int * interval '1 second')
                         THEN 1 ELSE auth_attempts.count + 1 END,
            window_start = CASE WHEN auth_attempts.window_start < now() - (${windowSeconds}::int * interval '1 second')
                                THEN now() ELSE auth_attempts.window_start END
        RETURNING count
    `;
    return Number(rows[0].count);
}

const clearHits = (sql, key) => sql`DELETE FROM auth_attempts WHERE key = ${key}`;

// ---------- sessions ----------
async function createSession(sql, ownerId) {
    const token = newToken();
    await sql`
        INSERT INTO sessions (token_hash, owner_id, expires_at)
        VALUES (${hashToken(token)}, ${ownerId}, now() + (${SESSION_DAYS}::int * interval '1 day'))
    `;
    return token;
}

// Returns { id, email, name, role } for a valid session cookie, else null.
async function getSession(sql, req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const rows = await sql`
        SELECT o.id, o.email, o.name, o.role, o.disabled
        FROM sessions s JOIN owners o ON o.id = s.owner_id
        WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()
        LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.disabled) return null;
    return { id: row.id, email: row.email, name: row.name, role: row.role };
}

const destroySession = (sql, req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return token ? sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}` : Promise.resolve();
};

// Reads a JSON body whether the platform parsed it or not.
const readBody = req => (req.body && typeof req.body === 'object' ? req.body : {});

module.exports = {
    COOKIE_NAME, SESSION_DAYS, MIN_PASSWORD, MAX_PASSWORD,
    hashPassword, verifyPassword, dummyVerify, validatePassword, validateEmail,
    newToken, hashToken, parseCookies, sessionCookie, clearCookie,
    requestHost, onPlatformHost, sameOrigin, clientIp,
    hit, clearHits, createSession, getSession, destroySession, readBody,
};
