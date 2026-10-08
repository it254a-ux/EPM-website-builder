// Domain pricing math. Pure arithmetic, no database or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../_lib/domain-pricing');

const KEYS = ['DOMAIN_PROFIT_PERCENT', 'DOMAIN_MIN_PROFIT_USD', 'DOMAIN_BUFFER_PERCENT', 'KES_PER_USD', 'KES_ROUND_TO'];
test.beforeEach(() => KEYS.forEach(k => delete process.env[k]));
test.afterEach(() => KEYS.forEach(k => delete process.env[k]));

test('defaults are 12 percent, a 2 dollar minimum and a 4 percent buffer', () => {
    assert.deepEqual(P.settings(), { profitPercent: 12, minProfitUsd: 2, bufferPercent: 4, kesPerUsd: 0, kesRoundTo: 10 });
});

test('the agreed examples come out exactly', () => {
    const cases = [[0.99, 200, 312], [10, 200, 1250], [15, 200, 1771], [30, 360, 3500], [60, 720, 7000]];
    for (const [cost, profit, price] of cases) {
        const r = P.priceFor(cost);
        assert.equal(r.profitCents, profit, `profit for ${cost}`);
        assert.equal(r.priceCents, price, `price for ${cost}`);
    }
});

test('the minimum protects cheap domains, and the percentage takes over on dear ones', () => {
    assert.equal(P.priceFor(0.99).profitCents, 200);
    assert.equal(P.priceFor(16.66).profitCents, 200);      // 12% = 1.9992 -> still the minimum
    assert.equal(P.priceFor(16.67).profitCents, 200);      // 12% = 2.0004 -> rounds to 200
    assert.equal(P.priceFor(20).profitCents, 240);
});

test('after the buffer is taken off, the seller still keeps cost plus profit', () => {
    for (const cost of [0.99, 2.5, 9.99, 12.88, 33.33, 99.99, 250]) {
        const r = P.priceFor(cost);
        const afterBuffer = r.priceCents * 0.96;
        assert.ok(afterBuffer >= r.costCents + r.profitCents - 1e-9, `cost ${cost}`);
        assert.ok(r.priceCents > r.costCents + r.profitCents, 'price is above cost plus profit');
    }
});

test('the price is rounded up and never lands a cent too high on an exact answer', () => {
    // 60.00 cost: (6000 + 720) / 0.96 is exactly 7000, and must not become 7001 through decimal drift.
    assert.equal(P.priceFor(60).priceCents, 7000);
    assert.equal(P.priceFor(30).priceCents, 3500);
});

test('settings can be changed without touching code, and nonsense falls back to the defaults', () => {
    process.env.DOMAIN_PROFIT_PERCENT = '20';
    process.env.DOMAIN_MIN_PROFIT_USD = '3';
    process.env.DOMAIN_BUFFER_PERCENT = '0';
    assert.equal(P.priceFor(10).priceCents, 1300);          // profit = max(2.00, 3.00) = 3.00, no buffer
    process.env.DOMAIN_PROFIT_PERCENT = 'abc';
    process.env.DOMAIN_MIN_PROFIT_USD = '-5';
    process.env.DOMAIN_BUFFER_PERCENT = '99';
    assert.deepEqual([P.settings().profitPercent, P.settings().minProfitUsd, P.settings().bufferPercent], [12, 2, 4]);
});

test('a missing or bad cost gives no price instead of a wrong one', () => {
    for (const bad of [0, -1, NaN, undefined, null, 'x']) assert.equal(P.priceFor(bad), null, String(bad));
});

test('shillings are rounded up to the next 10, and absent without a rate', () => {
    assert.equal(P.toKes(312), null);                       // no KES_PER_USD set: never guess a rate
    process.env.KES_PER_USD = '130';
    assert.equal(P.toKes(312), 410);                        // $3.12 x 130 = 405.60 -> 410
    assert.equal(P.toKes(1000), 1300);                      // $10.00 x 130 = 1300 exactly, stays 1300
    process.env.KES_PER_USD = '129.35';
    assert.equal(P.toKes(7000), 9060);                      // $70 x 129.35 = 9054.5 -> 9060
    process.env.KES_ROUND_TO = '1';
    assert.equal(P.toKes(7000), 9055);
});

test('dollars are shown with two decimals', () => {
    assert.equal(P.formatUsd(312), '$3.12');
    assert.equal(P.formatUsd(7000), '$70.00');
});
