// Vercel's free (Hobby) plan allows at most 12 serverless functions per deployment, and every .js file directly inside api/ is one.
// Going over makes the WHOLE deployment fail. Put shared code in api/_lib/ (not counted), and add new routes to an existing file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('api/ has at most 12 function files (Vercel Hobby limit)', () => {
    const files = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
    assert.ok(files.length <= 12, `api/ has ${files.length} functions (${files.join(', ')}). Vercel's free plan allows 12. Merge one into another file, or move shared code to api/_lib/.`);
});
