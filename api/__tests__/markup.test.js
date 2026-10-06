const test = require('node:test');
const assert = require('node:assert');
const S = require('../_lib/site-settings');

test('markup accepts 0 to 3 with up to two decimals', () => {
    assert.strictEqual(S.sanitizeMarkup('1'), 1);
    assert.strictEqual(S.sanitizeMarkup('1.94'), 1.94);
    assert.strictEqual(S.sanitizeMarkup(' 2.5% '), 2.5);
    assert.strictEqual(S.sanitizeMarkup('0'), 0);
    assert.strictEqual(S.sanitizeMarkup('3'), 3);
    assert.strictEqual(S.sanitizeMarkup(0.75), 0.75);
});

test('markup rejects out-of-range or malformed values', () => {
    for (const bad of ['3.01', '4', '-1', 'abc', '1.234', '1,5', '', null, undefined, '1e1']) {
        assert.strictEqual(S.sanitizeMarkup(bad), null, String(bad));
    }
});

test('app id accepts letters and numbers only', () => {
    assert.strictEqual(S.sanitizeAppId('33C8pzDfszs5p4KQabqit'), '33C8pzDfszs5p4KQabqit');
    assert.strictEqual(S.sanitizeAppId(' 12345 '), '12345');
    for (const bad of ['', 'ab', 'has space', 'a;b;c', '<script>', 'x'.repeat(41), null, undefined]) {
        assert.strictEqual(S.sanitizeAppId(bad), null, String(bad));
    }
});
