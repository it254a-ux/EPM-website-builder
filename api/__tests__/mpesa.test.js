// The M-Pesa module on its own: phone numbers, request shapes, reading Safaricom's answers. Safaricom is replaced by a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../_lib/mpesa');

const KEYS = ['MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'MPESA_TRANSACTION_TYPE', 'MPESA_PARTY_B'];
const configure = () => Object.assign(process.env, { MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'KEY123', MPESA_CONSUMER_SECRET: 'SECRET456', MPESA_SHORTCODE: '174379', MPESA_PASSKEY: 'PASSKEY789', MPESA_CALLBACK_SECRET: 'cbsecret' });
test.beforeEach(() => KEYS.forEach(k => delete process.env[k]));
test.afterEach(() => { KEYS.forEach(k => delete process.env[k]); M.setTransport(null); });

const fake = (handlers = {}) => {
    const calls = [];
    M.setTransport(async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/oauth/')) return handlers.oauth || { status: 200, body: { access_token: 'TOKEN-1', expires_in: '3599' } };
        if (url.includes('processrequest')) return handlers.push || { status: 200, body: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0' } };
        if (url.includes('stkpushquery')) return handlers.query || { status: 200, body: { ResultCode: '0', ResultDesc: 'ok' } };
        throw new Error('unexpected ' + url);
    });
    return calls;
};

test('settings: sandbox by default, production only when asked, and missing ones are named', () => {
    assert.equal(M.isConfigured(), false);
    assert.deepEqual(M.missingSettings(), ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET']);
    configure();
    assert.equal(M.isConfigured(), true);
    assert.equal(M.settings().base, 'https://sandbox.safaricom.co.ke');
    assert.equal(M.settings().type, 'CustomerPayBillOnline');
    process.env.MPESA_ENV = 'production';
    assert.equal(M.settings().base, 'https://api.safaricom.co.ke');
    process.env.MPESA_TRANSACTION_TYPE = 'CustomerBuyGoodsOnline'; process.env.MPESA_PARTY_B = '555000';
    assert.equal(M.settings().type, 'CustomerBuyGoodsOnline');
    assert.equal(M.settings().partyB, '555000');
});

test('phone numbers: the usual ways of writing a Safaricom number all become 2547...', () => {
    for (const ok of ['0712345678', '712345678', '+254712345678', '254712345678', '0712 345 678', '+254 712-345-678', '0112345678']) {
        assert.match(M.normalizePhone(ok), /^254[17]\d{8}$/, ok);
    }
    assert.equal(M.normalizePhone('0712345678'), '254712345678');
    for (const bad of ['', null, '12345', '0812345678', '+255712345678', 'abc', '07123456789', '071234567']) assert.equal(M.normalizePhone(bad), null, String(bad));
});

test('timestamp and password follow Daraja\'s format', () => {
    assert.equal(M.timestamp(new Date(Date.UTC(2026, 9, 9, 7, 5, 3))), '20261009070503');
    assert.equal(M.passwordFor('174379', 'PASS', '20261009070503'), Buffer.from('174379PASS20261009070503').toString('base64'));
});

test('the payment prompt request has every field Safaricom needs, and the token is reused', async () => {
    configure();
    const calls = fake();
    const r = await M.stkPush({ phone: '254712345678', amountKes: 1799.6, reference: 'EPM42-LONG-REFERENCE', description: 'Domain purchase long', callbackUrl: 'https://x.test/api/pay-callback?k=cbsecret' });
    assert.deepEqual(r, { ok: true, merchantId: 'mr1', checkoutId: 'ws_CO_1' });
    const oauth = calls[0], push = calls[1];
    assert.equal(oauth.url, 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    assert.equal(oauth.options.headers.Authorization, 'Basic ' + Buffer.from('KEY123:SECRET456').toString('base64'));
    assert.equal(push.url, 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
    assert.equal(push.options.headers.Authorization, 'Bearer TOKEN-1');
    const b = JSON.parse(push.options.body);
    assert.equal(b.BusinessShortCode, '174379');
    assert.equal(b.TransactionType, 'CustomerPayBillOnline');
    assert.equal(b.Amount, 1800);                                   // a whole number of shillings
    assert.equal(b.PartyA, '254712345678'); assert.equal(b.PhoneNumber, '254712345678'); assert.equal(b.PartyB, '174379');
    assert.equal(b.CallBackURL, 'https://x.test/api/pay-callback?k=cbsecret');
    assert.ok(b.AccountReference.length <= 12 && b.TransactionDesc.length <= 13);
    assert.equal(b.Password, M.passwordFor('174379', 'PASSKEY789', b.Timestamp));
    assert.match(b.Timestamp, /^\d{14}$/);

    await M.stkQuery('ws_CO_1');
    assert.equal(calls.filter(c => c.url.includes('/oauth/')).length, 1, 'one token serves both calls');
});

test('a refused prompt or refused keys give a plain message and never the secrets', async () => {
    configure();
    fake({ push: { status: 400, body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' } } });
    const bad = await M.stkPush({ phone: '254712345678', amountKes: 100, reference: 'EPM1', callbackUrl: 'https://x/y' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /could not send the payment prompt/);

    fake({ oauth: { status: 401, body: {} } });
    const keys = await M.stkPush({ phone: '254712345678', amountKes: 100, reference: 'EPM1', callbackUrl: 'https://x/y' });
    assert.equal(keys.ok, false);
    assert.match(keys.error, /not set up correctly/);
    for (const text of [JSON.stringify(bad), JSON.stringify(keys)]) for (const secret of ['KEY123', 'SECRET456', 'PASSKEY789']) assert.ok(!text.includes(secret));

    M.setTransport(async () => { throw new Error('socket hang up'); });
    assert.match((await M.stkPush({ phone: '254712345678', amountKes: 100, reference: 'EPM1', callbackUrl: 'https://x/y' })).error, /Could not reach M-Pesa/);
});

test('asking about a prompt: paid, failed, or still waiting', async () => {
    configure();
    fake({ query: { status: 200, body: { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' } } });
    assert.equal((await M.stkQuery('x')).paid, true);
    fake({ query: { status: 200, body: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' } } });
    const c = await M.stkQuery('x'); assert.equal(c.paid, false); assert.equal(c.code, 1032);
    fake({ query: { status: 500, body: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } } });
    assert.equal((await M.stkQuery('x')).paid, null);
    fake({ query: { status: 200, body: {} } });
    assert.equal((await M.stkQuery('x')).paid, null);
    M.setTransport(async () => { throw new Error('boom'); });
    assert.equal((await M.stkQuery('x')).paid, null);
});

test('reading the report Safaricom sends', () => {
    const ok = M.parseCallback({ Body: { stkCallback: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1800 }, { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } });
    assert.deepEqual(ok, { checkoutId: 'ws_CO_1', merchantId: 'mr1', resultCode: 0, desc: 'ok', amount: 1800, receipt: 'NLJ7RT61SV' });
    const cancelled = M.parseCallback({ Body: { stkCallback: { MerchantRequestID: 'mr1', CheckoutRequestID: 'ws_CO_2', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
    assert.equal(cancelled.resultCode, 1032); assert.equal(cancelled.amount, null); assert.equal(cancelled.receipt, null);
    for (const junk of [null, {}, { Body: {} }, { Body: { stkCallback: {} } }, 'text']) assert.equal(M.parseCallback(junk), null);
});
