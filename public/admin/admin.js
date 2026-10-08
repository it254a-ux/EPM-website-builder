/* Admin panel. Works only on the platform's own domains and only for role=admin accounts
   (the server enforces both -- this page is just a convenience). Rendered with textContent only. */
(function () {
    var app = document.getElementById('app');
    function api(path, method, body) {
        return fetch(path, { method: method || 'GET', credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
    }
    function el(tag, attrs, kids) {
        var e = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k];
            else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]);
        });
        (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
        return e;
    }
    function clear() { while (app.firstChild) app.removeChild(app.firstChild); }
    function act(body) { return api('/api/admin', 'POST', body).then(function (r) { if (r.error) alert(r.error); else if (r.warning) alert(r.warning); load(); }); }

    function login() {
        clear();
        var email = el('input', { type: 'email', placeholder: 'Admin email' }), pw = el('input', { type: 'password', placeholder: 'Password' }), msg = el('div', { class: 'err' });
        var go = el('button', { class: 'primary', text: 'Sign in', onclick: function () {
            api('/api/auth?action=login', 'POST', { email: email.value, password: pw.value }).then(function (r) {
                if (r.owner) load(); else msg.textContent = r.error || 'Could not sign in.'; }); } });
        app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Admin sign in' }), email, el('div', { style: 'height:8px' }), pw, msg, el('div', { style: 'margin-top:10px' }, [go])]));
    }

    function table(headers, rows) {
        var t = el('table', {}, [el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))]);
        rows.forEach(function (cells) { t.appendChild(el('tr', {}, cells.map(function (c) { return el('td', {}, [typeof c === 'string' ? document.createTextNode(c) : c]); }))); });
        return el('div', { class: 'scroll' }, [t]);
    }

    function render(sites, owners, pool, dv, cm) {
        clear();
        app.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' }, [
            el('span', { class: 'muted', text: sites.length + ' sites · ' + owners.length + ' accounts' }),
            el('button', { text: 'Sign out', onclick: function () { api('/api/auth?action=logout', 'POST').then(login); } })]));

        // ----- App ID stock (computed first so the warning sits on top) -----
        var LOW_STOCK = 2; // a tier with this many free apps or fewer is "running low"
        var waitingBy = {};
        sites.forEach(function (s) { if (!s.app_id) waitingBy[Number(s.markup_percent)] = (waitingBy[Number(s.markup_percent)] || 0) + 1; });
        var tierMap = {};
        (pool.tiers || []).forEach(function (t) { tierMap[Number(t.markup_percent)] = t; });
        [1, 1.5, 2, 2.5, 3].forEach(function (m) { if (!tierMap[m]) tierMap[m] = { markup_percent: m, free: 0, used: 0 }; });
        Object.keys(waitingBy).forEach(function (m) { if (!tierMap[Number(m)]) tierMap[Number(m)] = { markup_percent: Number(m), free: 0, used: 0 }; });
        function tierState(m) {
            var t = tierMap[m], w = waitingBy[m] || 0;
            if (w > 0 && t.free < w) return 'short';                       // sites are waiting and there are not enough free apps
            if ((t.used > 0 || w > 0) && t.free <= LOW_STOCK) return 'low'; // in use, and nearly out
            return 'ok';
        }
        var tierKeys = Object.keys(tierMap).map(Number).sort(function (a, b) { return a - b; });
        var shortTiers = tierKeys.filter(function (m) { return tierState(m) === 'short'; });
        var lowTiers = tierKeys.filter(function (m) { return tierState(m) === 'low'; });
        if (shortTiers.length || lowTiers.length) {
            var lines = [];
            shortTiers.forEach(function (m) { var need = (waitingBy[m] || 0) - tierMap[m].free; lines.push(m.toFixed(2) + '% markup: ' + (waitingBy[m] || 0) + ' site(s) waiting, add at least ' + need + ' more app(s).'); });
            lowTiers.forEach(function (m) { lines.push(m.toFixed(2) + '% markup: only ' + tierMap[m].free + ' free app(s) left. Add more soon.'); });
            app.appendChild(el('div', { class: 'card', style: 'border-color:#c0392b' }, [el('h2', { text: 'Add Deriv apps' }),
                el('p', { class: 'muted', text: 'New sites take the next free app for their markup. Make more in the Deriv dashboard, then paste their App IDs under "App IDs" below.' })]
                .concat(lines.map(function (t) { return el('p', { class: 'err', text: t }); }))));
        }

        var siteRows = sites.map(function (s) {
            var btns = el('div', { class: 'row' });
            if (s.status !== 'active') btns.appendChild(el('button', { text: 'Approve', onclick: function () { act({ action: 'set_status', site_id: s.id, status: 'active' }); } }));
            if (s.status !== 'suspended') btns.appendChild(el('button', { text: 'Suspend', onclick: function () { act({ action: 'set_status', site_id: s.id, status: 'suspended' }); } }));
            if (s.custom_domain_requested) btns.appendChild(el('button', { text: 'Approve ' + s.custom_domain_requested, onclick: function () {
                if (confirm('Add ' + s.custom_domain_requested + ' to Vercel first' + (s.app_source === 'api' ? ' (its Deriv app is updated automatically)' : s.app_id ? ' and to the redirect list of its Deriv app (' + s.app_id + ')' : '') + '. Switch the site now?')) act({ action: 'approve_custom', site_id: s.id }); } }));
            if (!s.app_id && dv.enabled) btns.appendChild(el('button', { text: 'Create on Deriv', onclick: function () { act({ action: 'create_app', site_id: s.id }); } }));
            if (!s.app_id) btns.appendChild(el('button', { text: 'Take from pool', onclick: function () { act({ action: 'assign_from_pool', site_id: s.id }); } }));
            btns.appendChild(el('button', { text: s.app_id ? 'Change App ID' : 'Assign App ID', onclick: function () {
                var v = prompt('Deriv App ID for ' + s.name + ' (create the app in Deriv first, with ' + s.markup_percent + '% markup). Leave blank to clear.', s.app_id || '');
                if (v === null) return; act({ action: 'set_app_id', site_id: s.id, app_id: v.trim() }); } }));
            btns.appendChild(el('button', { text: 'Set markup', onclick: function () {
                var v = prompt('Markup % for ' + s.name + ' (1 to 3). ' + (s.app_source === 'api' ? 'It is changed on the site\u2019s Deriv app as well.' : 'Keep it equal to the markup on its Deriv app.'), String(s.markup_percent));
                if (v === null) return; act({ action: 'set_markup', site_id: s.id, markup_percent: v.trim() }); } }));
            btns.appendChild(el('button', { text: 'Set rate', onclick: function () {
                var v = prompt('Platform share % for ' + s.name + ' (blank = plan default)', String(s.platform_share));
                if (v === null) return; act({ action: 'set_rate', site_id: s.id, platform_share: v.trim() === '' ? null : Number(v) }); } }));
            btns.appendChild(el('button', { text: 'Delete', onclick: function () {
                if (confirm('Permanently delete the site "' + s.name + '" (' + s.domain + ')? This cannot be undone.')) act({ action: 'delete_site', site_id: s.id }); } }));
            return [s.name, s.domain, s.plan, el('span', { class: 'pill', text: s.status }), s.platform_share + '%', (s.markup_pending ? el('span', { class: 'pill', text: Number(s.markup_percent) + '% \u00b7 update on Deriv' }) : Number(s.markup_percent) + '%'), s.app_id ? (s.app_source === 'api' ? s.app_id + ' \u00b7 auto' : s.app_id) : el('span', { class: 'pill', text: 'awaiting App ID' }), s.owner_email || '', btns];
        });
        // ----- Deriv connection -----
        var dvMsg = el('div', { class: 'muted' });
        var dvText = 'Experimental automatic app creation is ON. New sites try to get an app through Deriv\u2019s older API first and fall back to the App IDs below.' + (dv.missing && dv.missing.length ? ' Still missing: ' + dv.missing.join(', ') + '.' : '');
        var testBtn = el('button', { text: 'Test connection', onclick: function () {
            dvMsg.textContent = 'Checking...'; testBtn.disabled = true;
            api('/api/admin', 'POST', { action: 'deriv_test' }).then(function (r) {
                testBtn.disabled = false;
                dvMsg.textContent = r.error ? r.error : 'Connected to Deriv with the Admin scope' + (r.loginid ? ' (account ' + r.loginid + ')' : '') + (r.missing && r.missing.length ? '. Still missing: ' + r.missing.join(', ') + '.' : '. Ready.'); }); } });
        if (dv.enabled) app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Deriv connection' }), el('p', { class: 'muted', text: dvText }), el('div', { class: 'row' }, [testBtn, dvMsg])]));

        app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Sites' }), table(['Name', 'Domain', 'Plan', 'Status', 'You keep', 'Markup', 'App ID', 'Owner', 'Actions'], siteRows)]));

        // ----- Commissions -----
        (function () {
            function usd(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
            var cmMsg = el('div', { class: 'muted' });
            var today = new Date().toISOString().slice(0, 10);
            var from = el('input', { type: 'date', max: today, value: today }), to = el('input', { type: 'date', max: today, value: today });
            var syncBtn = el('button', { text: 'Sync from Deriv', onclick: function () {
                cmMsg.textContent = 'Reading from Deriv...'; syncBtn.disabled = true;
                api('/api/admin', 'POST', { action: 'commission_sync', from: from.value, to: to.value }).then(function (r) {
                    syncBtn.disabled = false;
                    if (r.error) { cmMsg.textContent = r.error; return; }
                    var matched = 0; (r.results || []).forEach(function (x) { matched += x.matched || 0; });
                    cmMsg.textContent = 'Done: ' + (r.results || []).length + ' day(s) read, ' + matched + ' site-day(s) stored.'; load(); }); } });
            if (!cm.configured) syncBtn.disabled = true;
            var intro = cm.configured
                ? 'Earnings are read from Deriv once a day (needs CRON_SECRET in Vercel) and when you press Sync. Up to 10 days at a time.' + (cm.last_synced ? ' Last read ' + new Date(cm.last_synced).toLocaleString() + '.' : ' Nothing has been read yet.')
                : 'Not connected. Add DERIV_STATS_TOKEN (a Deriv token with the application_read scope) in Vercel and redeploy. Optional: DERIV_STATS_APP_ID, and CRON_SECRET so the daily update runs.';
            var thisMonth = new Date().toISOString().slice(0, 7);
            var monthRows = (cm.months || []).map(function (m) {
                var action = m.confirmed ? el('span', { class: 'pill', text: 'Confirmed' }) : (m.month < thisMonth ? el('button', { text: 'Confirm Deriv paid', onclick: function () {
                    var warn = m.days_synced < m.days_in_month ? '\n\nWARNING: only ' + m.days_synced + ' of ' + m.days_in_month + ' days are synced. Sync the missing days first, because a confirmed month is frozen.' : '';
                    if (confirm('Confirm ' + m.month + '?\n\nOnly do this after Deriv has actually paid this month to you. Operators’ part: ' + usd(m.owner_usd) + ' becomes withdrawable and the month is frozen. This cannot be undone.' + warn)) act({ action: 'confirm_month', month: m.month }); } }) : el('span', { class: 'muted', text: 'Month not over' }));
                return [m.month, m.days_synced + ' / ' + m.days_in_month, usd(m.markup_usd), usd(m.owner_usd), usd(m.platform_usd), action];
            });
            var reqRows = (cm.requests || []).map(function (r) {
                var btns = el('div', { class: 'row' });
                if (r.status === 'requested') {
                    btns.appendChild(el('button', { class: 'primary', text: 'Mark paid', onclick: function () {
                        var ref = prompt('Pay ' + usd(r.amount_usd) + ' to ' + (r.method === 'mpesa' ? 'M-Pesa ' : 'USDT ' + r.network + ' ') + r.destination + '. Then enter the M-Pesa code or transaction hash:');
                        if (ref === null) return; act({ action: 'payout_paid', id: r.id, reference: ref.trim() }); } }));
                    btns.appendChild(el('button', { text: 'Reject', onclick: function () {
                        var note = prompt('Reason (the operator sees this). You can leave it blank:', '');
                        if (note === null) return; act({ action: 'payout_reject', id: r.id, note: note.trim() }); } }));
                }
                return [new Date(r.created_at).toLocaleString(), (r.owner_name || '') + ' ' + (r.owner_email || ''), r.site_domain || '', usd(r.amount_usd),
                    (r.method === 'mpesa' ? 'M-Pesa ' : 'USDT ' + (r.network || '') + ' ') + r.destination, el('span', { class: 'pill', text: r.status + (r.reference ? ' · ' + r.reference : '') }), btns];
            });
            app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Commissions' }), el('p', { class: 'muted', text: intro }),
                el('div', { class: 'row' }, [el('span', { class: 'muted', text: 'From' }), from, el('span', { class: 'muted', text: 'to' }), to, syncBtn, cmMsg]),
                el('div', { style: 'height:10px' }),
                monthRows.length ? table(['Month', 'Days synced', 'Deriv markup', 'Operators’ part', 'Your part', ''], monthRows) : el('p', { class: 'muted', text: 'No earnings stored yet.' }),
                el('h2', { style: 'margin-top:16px', text: 'Withdrawal requests' }),
                reqRows.length ? table(['Requested', 'Operator', 'Site', 'Amount', 'Pay to', 'Status', ''], reqRows) : el('p', { class: 'muted', text: 'No withdrawal requests yet.' })]));
        })();

        // ----- App IDs (the pool) -----
        var tierRows = tierKeys.map(function (m) {
            var t = tierMap[m], w = waitingBy[m] || 0, st = tierState(m);
            return [m.toFixed(2) + '%', String(t.free), String(t.used), w ? el('span', { class: 'pill', text: w + ' waiting' }) : '0',
                st === 'short' ? el('span', { class: 'pill', text: 'Add apps now' }) : st === 'low' ? el('span', { class: 'pill', text: 'Running low' }) : 'OK'];
        });
        var tierSel = el('select', {}, [1, 1.5, 2, 2.5, 3].map(function (m) { return el('option', { value: String(m), text: m.toFixed(2) + '% markup' }); }));
        var idsBox = el('textarea', { rows: '4', placeholder: 'Paste the App IDs of apps you made in Deriv with this markup. One per line, or separated by commas.' });
        var poolMsg = el('div', { class: 'muted' });
        var addBtn = el('button', { class: 'primary', text: 'Add to pool', onclick: function () {
            poolMsg.textContent = ''; addBtn.disabled = true;
            api('/api/admin', 'POST', { action: 'pool_add', markup_percent: tierSel.value, app_ids: idsBox.value }).then(function (r) {
                addBtn.disabled = false;
                if (r.error) { poolMsg.textContent = r.error; return; }
                alert('Added ' + r.added + (r.skipped ? ', skipped ' + r.skipped + ' (already known)' : '') + (r.assigned ? '. ' + r.assigned + ' waiting site(s) got an App ID.' : '.')); load(); }); } });
        app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'App IDs' }),
            el('p', { class: 'muted', text: 'Deriv apps are made in the Deriv dashboard, so make them ahead of time: one app per future site, with the markup of its group and your main site\u2019s redirect URL. Paste the App IDs here. When a site is created it automatically takes the next free app with exactly its markup, one site per app. If a group runs out, the site waits as "awaiting App ID" and gets one the moment you add apps.' }),
            table(['Markup', 'Free', 'Used', 'Sites waiting', 'Status'], tierRows),
            el('div', { style: 'height:10px' }), tierSel, el('div', { style: 'height:8px' }), idsBox, el('div', { class: 'row', style: 'margin-top:8px' }, [addBtn, poolMsg])]));

        var ownerRows = owners.map(function (o) {
            var b = o.role === 'operator' ? el('div', { class: 'row' }, [
                el('button', { text: o.disabled ? 'Enable' : 'Disable', onclick: function () { act({ action: 'disable_owner', owner_id: o.id, disabled: !o.disabled }); } }),
                el('button', { text: 'Delete', onclick: function () {
                    if (confirm('Permanently delete the account ' + o.email + ' AND its site? This cannot be undone.')) act({ action: 'delete_owner', owner_id: o.id }); } })
            ]) : el('span', { class: 'muted', text: 'admin' });
            return [o.email, o.name, o.role, o.disabled ? 'disabled' : 'active', b];
        });
        app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Accounts' }), table(['Email', 'Name', 'Role', 'State', ''], ownerRows)]));
    }

    function load() {
        Promise.all([api('/api/admin?resource=sites'), api('/api/admin?resource=owners'), api('/api/admin?resource=pool'), api('/api/admin?resource=deriv'), api('/api/admin?resource=commissions')]).then(function (r) {
            if (r[0].__status === 401) return login();
            if (r[0].__status === 403) { clear(); app.appendChild(el('p', { class: 'err', text: 'This account is not an admin.' })); return; }
            if (r[0].__status === 404) { clear(); app.appendChild(el('p', { class: 'err', text: 'Admin is not available on this domain.' })); return; }
            render(r[0].sites || [], r[1].owners || [], r[2] && !r[2].error ? r[2] : { tiers: [], apps: [] }, r[3] && !r[3].error ? r[3] : { enabled: false, configured: false, missing: [] }, r[4] && !r[4].error ? r[4] : { configured: false, months: [], requests: [] });
        });
    }
    load();
})();
