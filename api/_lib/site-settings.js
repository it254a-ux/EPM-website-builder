// Shared helpers for per-domain site settings (CommonJS, like the other api/ files).
// Everything an operator can customise is validated here, so the public endpoint
// never hands the browser an unchecked string.

// Keep in sync with SUPPORTED_FONTS in src/utils/load-web-font.ts.
const SUPPORTED_FONTS = [
    'Inter', 'Roboto', 'Poppins', 'DM Sans', 'Lato',
    'Nunito', 'Open Sans', 'Montserrat', 'Raleway', 'Source Sans 3',
];

// What YOU keep (percent) per plan. Change here, or override per site in the DB.
const PLAN_SHARE = { free: 25, custom: 15 };

const RESERVED_SUBDOMAINS = [
    'www', 'admin', 'api', 'owner', 'app', 'mail', 'support', 'help', 'login', 'dashboard',
    'billing', 'status', 'blog', 'docs', 'static', 'assets', 'cdn', 'ftp', 'root', 'test',
    'epm', 'deriv', 'official', 'security', 'staff',
];

const clean = v => (typeof v === 'string' ? v.trim() : '');

function sanitizeName(v) {
    const s = clean(v).replace(/[<>]/g, '');
    return s.length >= 2 && s.length <= 60 ? s : '';
}

function sanitizeColor(v) {
    const s = clean(v);
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '';
}

function sanitizeFont(v) {
    const s = clean(v);
    return SUPPORTED_FONTS.includes(s) ? s : '';
}

function sanitizeLogoUrl(v) {
    const s = clean(v);
    if (!s || s.length > 500) return '';
    try {
        const u = new URL(s);
        return u.protocol === 'https:' ? u.toString() : '';
    } catch {
        return '';
    }
}

// WhatsApp: digits only with country code (7-15 digits). Accepts "+254 7xx xxx xxx".
function sanitizeWhatsapp(v) {
    const digits = clean(v).replace(/[^0-9]/g, '');
    return /^[0-9]{7,15}$/.test(digits) ? digits : '';
}

// Phone: keeps a leading + and digits only.
function sanitizePhone(v) {
    const s = clean(v);
    const digits = s.replace(/[^0-9]/g, '');
    if (!/^[0-9]{6,15}$/.test(digits)) return '';
    return (s.startsWith('+') ? '+' : '') + digits;
}

function sanitizeEmail(v) {
    const s = clean(v).toLowerCase();
    return s.length <= 120 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s) ? s : '';
}

// Telegram: username only. Accepts "@name" or "https://t.me/name".
function sanitizeTelegram(v) {
    const s = clean(v).replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
    return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s : '';
}

// Free-site label: "Alice-Trading" -> "alice-trading" (3-30 chars, not reserved).
function sanitizeSubdomain(v) {
    const s = clean(v).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/.test(s) || s.includes('--')) return '';
    return RESERVED_SUBDOMAINS.includes(s) ? '' : s;
}

// About / vision / mission: plain text, no control characters, max 1500 chars.
function sanitizeText(v) {
    const s = clean(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    return s.length <= 1500 ? s : '';
}

// Domain: "https://WWW.Trade.Alice.com/path" -> "trade.alice.com". Returns '' if invalid.
function sanitizeDomain(v) {
    let s = clean(v).toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    s = s.replace(/^www\./, '');
    const ok = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s);
    return ok ? s : '';
}

// Validates operator/admin input for a site. Invalid non-empty values are REJECTED
// (with a message) instead of being silently dropped. Blank optional fields are allowed.
function validateSiteInput(input, { requireName = false, requireDomain = false, allowDomain = false, ignoreContacts = false } = {}) {
    const errors = {};
    const value = {};
    const has = k => input && Object.prototype.hasOwnProperty.call(input, k);
    const optional = (key, fn, label) => {
        if (!has(key)) return;
        const raw = clean(input[key]);
        if (!raw) { value[key] = ''; return; }
        const out = fn(raw);
        if (!out) errors[key] = `${label} is not valid.`;
        else value[key] = out;
    };

    if (requireName || has('name')) {
        const n = sanitizeName(input && input.name);
        if (!n) errors.name = 'Site name must be 2-60 characters.';
        else value.name = n;
    }
    optional('primary_color', sanitizeColor, 'Colour (use #rrggbb)');
    optional('font', sanitizeFont, 'Font');
    optional('logo_url', sanitizeLogoUrl, 'Logo URL (must start with https://)');
    optional('about', sanitizeText, 'About text (max 1500 characters)');
    optional('vision', sanitizeText, 'Vision text (max 1500 characters)');
    optional('mission', sanitizeText, 'Mission text (max 1500 characters)');
    if (!ignoreContacts) {
        optional('whatsapp', sanitizeWhatsapp, 'WhatsApp number (include country code)');
        optional('phone', sanitizePhone, 'Phone number');
        optional('support_email', sanitizeEmail, 'Support email');
        optional('telegram', sanitizeTelegram, 'Telegram username');
    }

    if (allowDomain && (requireDomain || has('domain'))) {
        const d = sanitizeDomain(input && input.domain);
        if (!d) errors.domain = 'Enter a valid domain such as trade.yourbrand.com.';
        else value.domain = d;
    }
    return { value, errors, ok: Object.keys(errors).length === 0 };
}

// Turns a DB row (or admin input) into the public shape. Blank/invalid contact
// fields become '' so the client hides them -- they NEVER fall back to the
// platform's own contact details.
function toPublicSite(row) {
    const plan = row.plan === 'free' ? 'free' : 'custom';
    // Free sites: support goes to the platform (the client falls back to the platform's
    // contacts), so operator contact fields are never sent. Custom sites: operator's own only.
    const blank = { whatsapp: '', phone: '', email: '', telegram: '' };
    return {
        plan,
        powered_by: plan === 'free',
        name: sanitizeName(row.name),
        primary_color: sanitizeColor(row.primary_color),
        font: sanitizeFont(row.font),
        logo_url: sanitizeLogoUrl(row.logo_url),
        about: sanitizeText(row.about),
        vision: sanitizeText(row.vision),
        mission: sanitizeText(row.mission),
        contacts:
            plan === 'free'
                ? blank
                : {
                      whatsapp: sanitizeWhatsapp(row.whatsapp),
                      phone: sanitizePhone(row.phone),
                      email: sanitizeEmail(row.support_email),
                      telegram: sanitizeTelegram(row.telegram),
                  },
    };
}

// "Trade.Alice.com:443" -> "trade.alice.com"
function normalizeHost(raw) {
    const first = clean(String(raw || '').split(',')[0]).toLowerCase();
    return first.replace(/:\d+$/, '').replace(/\.$/, '');
}

function parsePlatformHosts(env) {
    return clean(env || '')
        .split(',')
        .map(normalizeHost)
        .filter(Boolean);
}

const isLocalHost = host => host === 'localhost' || host === '127.0.0.1';

// Decides what a host should see.
//  - row found and active  -> that site
//  - host is a platform host (or PLATFORM_HOSTS is unset, i.e. today's behaviour)
//                          -> 'platform' (the build-time EPM defaults)
//  - anything else         -> 'unconfigured' (never shows the platform's branding/contacts)
function decide({ host, row, platformHosts }) {
    if (row && row.status === 'active') return { kind: 'site', site: toPublicSite(row) };
    if (row) return { kind: 'unconfigured', reason: row.status === 'pending' ? 'pending' : 'suspended' };
    if (platformHosts.length === 0) return { kind: 'platform' };
    if (platformHosts.includes(host) || isLocalHost(host)) return { kind: 'platform' };
    return { kind: 'unconfigured', reason: 'unknown_domain' };
}

module.exports = {
    SUPPORTED_FONTS,
    sanitizeName, sanitizeColor, sanitizeFont, sanitizeLogoUrl,
    sanitizeWhatsapp, sanitizePhone, sanitizeEmail, sanitizeTelegram,
    sanitizeDomain, sanitizeSubdomain, sanitizeText, validateSiteInput, toPublicSite,
    PLAN_SHARE, RESERVED_SUBDOMAINS, normalizeHost, parsePlatformHosts, decide, isLocalHost,
};
