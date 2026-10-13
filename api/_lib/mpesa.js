// M-Pesa Express (STK push) through Safaricom's Daraja API: the customer gets a payment prompt on their phone.
// Field names follow the public Daraja examples. UNTESTED against live Safaricom: the sandbox run is the first real test.
//
// Settings (Vercel environment variables):
//   MPESA_ENV               sandbox (default) or production
//   MPESA_CONSUMER_KEY      from your Daraja app
//   MPESA_CONSUMER_SECRET   from your Daraja app
//   MPESA_SHORTCODE         sandbox: 174379. Live: your Paybill number
//   MPESA_PASSKEY           from the Daraja app (sandbox) or issued by Safaricom when you go live
//   MPESA_CALLBACK_SECRET   long random text. It is part of the address Safaricom reports payments to, so strangers cannot fake one
//   MPESA_TRANSACTION_TYPE  optional, default CustomerPayBillOnline (Paybill). Use CustomerBuyGoodsOnline for a Till.
//   MPESA_PARTY_B           optional, default = the shortcode. For a Till, the Till number.
// Nothing here is ever logged or returned with a secret in it.

const env = k => String(process.env[k] || '').trim();
const TIMEOUT_MS = 12000;

function settings() {
    const live = env('MPESA_ENV').toLowerCase() === 'production';
    return {
        live,
        base: live ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke',
        key: env('MPESA_CONSUMER_KEY'), secret: env('MPESA_CONSUMER_SECRET'),
        shortcode: env('MPESA_SHORTCODE'), passkey: env('MPESA_PASSKEY'),
        callbackSecret: env('MPESA_CALLBACK_SECRET'),
        type: env('MPESA_TRANSACTION_TYPE') === 'CustomerBuyGoodsOnline' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        partyB: env('MPESA_PARTY_B') || env('MPESA_SHORTCODE'),
    };
}
const missingSettings = () => {
    const s = settings(), out = [];
    if (!s.key) out.push('MPESA_CONSUMER_KEY');
    if (!s.secret) out.push('MPESA_CONSUMER_SECRET');
    if (!s.shortcode) out.push('MPESA_SHORTCODE');
    if (!s.passkey) out.push('MPESA_PASSKEY');
    if (!s.callbackSecret) out.push('MPESA_CALLBACK_SECRET');
    return out;
};
const isConfigured = () => missingSettings().length === 0;

async function defaultTransport(url, options) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...options, signal: ctl.signal });
        let body = null;
        try { body = await r.json(); } catch (e) { /* not JSON */ }
        return { status: r.status, body };
    } finally { clearTimeout(timer); }
}
let transport = defaultTransport;
let cached = null;
const setTransport = fn => { transport = fn || defaultTransport; cached = null; };

// 0712345678, 712345678, +254712345678, 254 712 345 678 -> 254712345678. Anything else -> null.
function normalizePhone(input) {
    let d = String(input || '').replace(/[\s\-().]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
    else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
    return /^254[17]\d{8}$/.test(d) ? d : null;
}

const pad = n => String(n).padStart(2, '0');
function timestamp(now = new Date()) {
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}
const passwordFor = (shortcode, passkey, ts) => Buffer.from(shortcode + passkey + ts).toString('base64');

async function accessToken() {
    if (cached && cached.exp > Date.now() + 30000) return cached.token;
    const s = settings();
    const res = await transport(`${s.base}/oauth/v1/generate?grant_type=client_credentials`, {
        method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(`${s.key}:${s.secret}`).toString('base64') },
    });
    const token = res && res.status === 200 && res.body && res.body.access_token;
    if (!token) throw new Error('M-Pesa refused our keys (check MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_ENV).');
    cached = { token, exp: Date.now() + (Number(res.body.expires_in) || 3000) * 1000 };
    return token;
}

async function post(path, payload) {
    const s = settings();
    const token = await accessToken();
    return transport(`${s.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

// Sends the payment prompt. Returns { ok:true, merchantId, checkoutId } or { ok:false, error } (error is safe to show).
async function stkPush({ phone, amountKes, reference, description, callbackUrl }) {
    const s = settings();
    const ts = timestamp();
    let res;
    try {
        res = await post('/mpesa/stkpush/v1/processrequest', {
            BusinessShortCode: s.shortcode, Password: passwordFor(s.shortcode, s.passkey, ts), Timestamp: ts,
            TransactionType: s.type, Amount: Math.round(amountKes), PartyA: phone, PartyB: s.partyB, PhoneNumber: phone,
            CallBackURL: callbackUrl, AccountReference: String(reference).slice(0, 12), TransactionDesc: String(description || 'Domain').slice(0, 13),
        });
    } catch (err) {
        return { ok: false, error: /refused our keys/.test(err.message) ? 'M-Pesa is not set up correctly yet.' : 'Could not reach M-Pesa. Please try again.' };
    }
    const b = (res && res.body) || {};
    if (res && res.status === 200 && String(b.ResponseCode) === '0' && b.CheckoutRequestID) {
        return { ok: true, merchantId: String(b.MerchantRequestID || ''), checkoutId: String(b.CheckoutRequestID) };
    }
    return { ok: false, error: 'M-Pesa could not send the payment prompt. Check the number and try again.' };
}

// Asks Safaricom what happened to a prompt. paid: true (paid), false (failed or cancelled), null (still waiting or unknown).
async function stkQuery(checkoutId) {
    const s = settings();
    const ts = timestamp();
    let res;
    try {
        res = await post('/mpesa/stkpushquery/v1/query', { BusinessShortCode: s.shortcode, Password: passwordFor(s.shortcode, s.passkey, ts), Timestamp: ts, CheckoutRequestID: checkoutId });
    } catch (err) { return { paid: null, desc: 'unreachable' }; }
    const b = (res && res.body) || {};
    if (b.ResultCode === undefined || b.ResultCode === null || b.ResultCode === '') return { paid: null, desc: String(b.errorMessage || 'pending').slice(0, 120) };
    return { paid: Number(b.ResultCode) === 0, code: Number(b.ResultCode), desc: String(b.ResultDesc || '').slice(0, 120) };
}

// Reads Safaricom's report of a finished prompt. Returns null if it does not look like one.
function parseCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    if (!cb || !cb.CheckoutRequestID) return null;
    const items = (cb.CallbackMetadata && Array.isArray(cb.CallbackMetadata.Item)) ? cb.CallbackMetadata.Item : [];
    const get = name => { const i = items.find(x => x && x.Name === name); return i ? i.Value : undefined; };
    const amount = Number(get('Amount'));
    return {
        checkoutId: String(cb.CheckoutRequestID), merchantId: String(cb.MerchantRequestID || ''),
        resultCode: Number(cb.ResultCode), desc: String(cb.ResultDesc || '').slice(0, 120),
        amount: Number.isFinite(amount) ? amount : null,
        receipt: get('MpesaReceiptNumber') ? String(get('MpesaReceiptNumber')).slice(0, 30) : null,
    };
}

// ---------- paying out: M-Pesa business payment (B2C) ----------
// Settings (all in Vercel). B2C is a separate Safaricom product from the payment prompt above, with its own approval.
//   MPESA_B2C_SHORTCODE            the shortcode money is paid FROM (sandbox: from the Daraja "Test credentials" page)
//   MPESA_B2C_INITIATOR            the API operator username created for it in M-Pesa (sandbox: testapi)
//   MPESA_B2C_CREDENTIAL           the ready-made Security Credential (the encrypted initiator password), OR instead of it:
//   MPESA_B2C_INITIATOR_PASSWORD + MPESA_B2C_CERT   the password and Safaricom's certificate (PEM text), and we encrypt it here
// UNTESTED against live Safaricom.
const nodeCrypto = require('crypto');

function b2cSettings() {
    return {
        shortcode: env('MPESA_B2C_SHORTCODE'), initiator: env('MPESA_B2C_INITIATOR'),
        credential: env('MPESA_B2C_CREDENTIAL'), password: env('MPESA_B2C_INITIATOR_PASSWORD'),
        cert: env('MPESA_B2C_CERT').replace(/\\n/g, '\n'),
    };
}
function b2cMissing() {
    const b = b2cSettings(), s = settings(), out = [];
    if (!s.key || !s.secret) out.push('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET');
    if (!s.callbackSecret) out.push('MPESA_CALLBACK_SECRET');
    if (!b.shortcode) out.push('MPESA_B2C_SHORTCODE');
    if (!b.initiator) out.push('MPESA_B2C_INITIATOR');
    if (!b.credential && !(b.password && b.cert)) out.push('MPESA_B2C_CREDENTIAL (or MPESA_B2C_INITIATOR_PASSWORD with MPESA_B2C_CERT)');
    return out;
}
const b2cConfigured = () => b2cMissing().length === 0;

function securityCredential() {
    const b = b2cSettings();
    if (b.credential) return b.credential;
    return nodeCrypto.publicEncrypt({ key: nodeCrypto.createPublicKey(b.cert), padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, Buffer.from(b.password)).toString('base64');
}

// Asks Safaricom to send money. { ok:true, conversationId } | { ok:false, kind:'rejected'|'unclear', error }
//   rejected  Safaricom refused before sending anything. Safe to try again.
//   unclear   we cannot tell if it went through (no answer). A person must check the M-Pesa statement.
async function b2cPay({ phone, amountKes, remarks, resultUrl, timeoutUrl }) {
    const b = b2cSettings();
    let cred;
    try { cred = securityCredential(); } catch (err) { return { ok: false, kind: 'rejected', error: 'The M-Pesa payout certificate or password is not valid.' }; }
    let res;
    try {
        res = await post('/mpesa/b2c/v1/paymentrequest', {
            InitiatorName: b.initiator, SecurityCredential: cred, CommandID: 'BusinessPayment', Amount: Math.floor(amountKes),
            PartyA: b.shortcode, PartyB: phone, Remarks: String(remarks || 'Payout').slice(0, 100), QueueTimeOutURL: timeoutUrl, ResultURL: resultUrl, Occasion: 'Payout',
        });
    } catch (err) {
        if (/refused our keys/.test(err.message)) return { ok: false, kind: 'rejected', error: 'M-Pesa refused our keys.' };
        return { ok: false, kind: 'unclear', error: 'No answer from M-Pesa. It may or may not have been sent.' };
    }
    const status = res && res.status, bdy = (res && res.body) || {};
    if (status === 200 && String(bdy.ResponseCode) === '0') return { ok: true, conversationId: String(bdy.OriginatorConversationID || bdy.ConversationID || '').slice(0, 80) };
    if (status >= 500 || !status) return { ok: false, kind: 'unclear', error: 'M-Pesa had a server error. It may or may not have been sent.' };
    const why = String(bdy.errorMessage || bdy.ResponseDescription || `error ${status}`).replace(/[\r\n]+/g, ' ').slice(0, 120);
    return { ok: false, kind: 'rejected', error: `M-Pesa refused it: ${why}` };
}

// Safaricom's report that a payout finished or failed. Returns null if it does not look like one.
function parseB2cResult(body) {
    const r = body && body.Result;
    if (!r || r.ResultCode === undefined) return null;
    const params = (r.ResultParameters && Array.isArray(r.ResultParameters.ResultParameter)) ? r.ResultParameters.ResultParameter : [];
    const get = k => { const p = params.find(x => x && x.Key === k); return p ? p.Value : undefined; };
    const amount = Number(get('TransactionAmount'));
    return {
        code: Number(r.ResultCode), desc: String(r.ResultDesc || '').slice(0, 160),
        conversation: String(r.OriginatorConversationID || '').slice(0, 80),
        receipt: String(r.TransactionID || get('TransactionReceipt') || '').slice(0, 40) || null,
        amount: Number.isFinite(amount) ? amount : null,
    };
}

module.exports = { b2cSettings, b2cMissing, b2cConfigured, b2cPay, parseB2cResult, securityCredential, settings, isConfigured, missingSettings, setTransport, defaultTransport, normalizePhone, timestamp, passwordFor, stkPush, stkQuery, parseCallback };
