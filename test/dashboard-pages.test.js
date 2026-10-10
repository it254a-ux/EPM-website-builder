// Opens every dashboard page in a simulated browser and fails if one throws or renders blank.
// Run with: npm run test:pages
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = path.join(__dirname, '..', 'public', 'app');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
const ownerJs = fs.readFileSync(path.join(APP, 'owner.js'), 'utf8');

const COMMISSIONS = { summary: { available: 0, pending: 0, paid: 0, requested: 0, this_month: 0, this_month_label: '2026-10', latest_day: null, latest_day_amount: 0 }, months: [], withdrawals: [], history: [] };
const LIBRARY = { limits: { file_mb: 10, open_requests: 3 }, storage_ready: true, site: { name: 'Test', domain: 'test.example' }, strategies: [], bots: [], requests: [] };
const BOOTSTRAP = {
  owner: { name: 'Test Owner', email: 'owner@example.com', role: 'owner' }, google: false,
  state: { site: null, events: [], free_root: 'epm.example' }, commissions: COMMISSIONS, library: LIBRARY,
};

const PAGES = ['sites', 'domains', 'deployments', 'commissions', 'bots', 'strategies', 'support', 'settings'];

function openDashboard(hash) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    const msg = String((e && e.detail) || (e && e.message) || e);
    if (!/Not implemented/.test(msg)) errors.push(msg); // the simulated browser lacks some features; those are not app bugs
  });
  const dom = new JSDOM(html, { url: 'http://localhost/app/' + hash, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  w.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('bootstrap') ? BOOTSTRAP : u.includes('library') ? LIBRARY : u.includes('commission') ? COMMISSIONS : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  w.addEventListener('error', (e) => errors.push(String(e.message)));
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(ownerJs);
  return { dom, w, errors };
}

for (const page of PAGES) {
  test('dashboard page "' + page + '" renders without errors', async () => {
    const { dom, w, errors } = openDashboard('#/' + page);
    await new Promise((r) => setTimeout(r, 400));
    const text = (w.document.getElementById('view') || {}).textContent || '';
    dom.window.close();
    assert.deepEqual(errors, [], 'page threw: ' + errors.join(' | '));
    assert.ok(text.trim().length > 30, 'page is blank');
  });
}
