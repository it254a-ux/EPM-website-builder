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
    function act(body) { return api('/api/admin', 'POST', body).then(function (r) { if (r.error) alert(r.error); load(); }); }

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

    function render(sites, owners) {
        clear();
        app.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' }, [
            el('span', { class: 'muted', text: sites.length + ' sites · ' + owners.length + ' accounts' }),
            el('button', { text: 'Sign out', onclick: function () { api('/api/auth?action=logout', 'POST').then(login); } })]));

        var siteRows = sites.map(function (s) {
            var btns = el('div', { class: 'row' });
            if (s.status !== 'active') btns.appendChild(el('button', { text: 'Approve', onclick: function () { act({ action: 'set_status', site_id: s.id, status: 'active' }); } }));
            if (s.status !== 'suspended') btns.appendChild(el('button', { text: 'Suspend', onclick: function () { act({ action: 'set_status', site_id: s.id, status: 'suspended' }); } }));
            if (s.custom_domain_requested) btns.appendChild(el('button', { text: 'Approve ' + s.custom_domain_requested, onclick: function () {
                if (confirm('Add ' + s.custom_domain_requested + ' to Vercel and your Deriv redirect list first. Switch the site now?')) act({ action: 'approve_custom', site_id: s.id }); } }));
            btns.appendChild(el('button', { text: s.app_id ? 'Change App ID' : 'Assign App ID', onclick: function () {
                var v = prompt('Deriv App ID for ' + s.name + ' (create the app in Deriv first, with ' + s.markup_percent + '% markup). Leave blank to clear.', s.app_id || '');
                if (v === null) return; act({ action: 'set_app_id', site_id: s.id, app_id: v.trim() }); } }));
            btns.appendChild(el('button', { text: 'Set markup', onclick: function () {
                var v = prompt('Markup % for ' + s.name + ' (1 to 3). Keep it equal to the markup on its Deriv app.', String(s.markup_percent));
                if (v === null) return; act({ action: 'set_markup', site_id: s.id, markup_percent: v.trim() }); } }));
            btns.appendChild(el('button', { text: 'Set rate', onclick: function () {
                var v = prompt('Platform share % for ' + s.name + ' (blank = plan default)', String(s.platform_share));
                if (v === null) return; act({ action: 'set_rate', site_id: s.id, platform_share: v.trim() === '' ? null : Number(v) }); } }));
            btns.appendChild(el('button', { text: 'Delete', onclick: function () {
                if (confirm('Permanently delete the site "' + s.name + '" (' + s.domain + ')? This cannot be undone.')) act({ action: 'delete_site', site_id: s.id }); } }));
            return [s.name, s.domain, s.plan, el('span', { class: 'pill', text: s.status }), s.platform_share + '%', (s.markup_pending ? el('span', { class: 'pill', text: Number(s.markup_percent) + '% \u00b7 update on Deriv' }) : Number(s.markup_percent) + '%'), s.app_id ? s.app_id : el('span', { class: 'pill', text: 'awaiting App ID' }), s.owner_email || '', btns];
        });
        app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Sites' }), table(['Name', 'Domain', 'Plan', 'Status', 'You keep', 'Markup', 'App ID', 'Owner', 'Actions'], siteRows)]));

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
        Promise.all([api('/api/admin?resource=sites'), api('/api/admin?resource=owners')]).then(function (r) {
            if (r[0].__status === 401) return login();
            if (r[0].__status === 403) { clear(); app.appendChild(el('p', { class: 'err', text: 'This account is not an admin.' })); return; }
            if (r[0].__status === 404) { clear(); app.appendChild(el('p', { class: 'err', text: 'Admin is not available on this domain.' })); return; }
            render(r[0].sites || [], r[1].owners || []);
        });
    }
    load();
})();
