/* Site owner dashboard. Everything from the server is rendered with textContent (never innerHTML). */
(function () {
    'use strict';

    var MARKETING = ''; // Terms and Privacy live on this same site
    var WA = '254115533208', WA_SHOW = '+254 115 533 208';
    var FONTS = ['', 'Inter', 'Roboto', 'Poppins', 'DM Sans', 'Lato', 'Nunito', 'Open Sans', 'Montserrat', 'Raleway', 'Source Sans 3'];
    var root = document.getElementById('app');
    var S = { owner: null, site: null, comm: null, lib: null, google: false, freeRoot: '', dns: { cname: 'cname.vercel-dns-0.com', a: '76.76.21.21' }, events: [] };
    var installEvent = null, viewEl = null, sideEl = null, scrimEl = null, whoEl = null;

    /* ---------- helpers ---------- */
    // Everything the server sends is kept in memory (S.site, S.comm, S.lib), so pages and tabs show at once and refresh quietly.
    function strip(j) { var c = {}; Object.keys(j).forEach(function (k) { if (k !== '__status') c[k] = j[k]; }); return c; }
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function api(path, method, body) {
        return fetch(path, {
            method: method || 'GET', credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status;
                if (r.ok && path.indexOf('/api/commissions') === 0 && j.summary) S.comm = strip(j);
                if (r.ok && path.indexOf('/api/library') === 0 && j.limits) S.lib = strip(j);
                return j; }); })
            .catch(function () { return { error: 'Could not reach the server. Check your connection.', __status: 0 }; });
    }
    function el(tag, attrs, kids) {
        var e = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v;
            else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v);
        });
        (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return e;
    }
    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
    function svg(d) {
        var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
        s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
        var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p); return s;
    }
    function googleIcon() {
        var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
        [['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
         ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
         ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
         ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']]
            .forEach(function (p) { var e = document.createElementNS(ns, 'path'); e.setAttribute('fill', p[0]); e.setAttribute('d', p[1]); s.appendChild(e); });
        return s;
    }
    var GOOGLE_MESSAGES = {
        unavailable: 'Google sign-in is not available right now.',
        denied: 'Google sign-in was cancelled.',
        error: 'We could not sign you in with Google. Please try again.',
        terms: 'There is no account for that Google address yet. Choose "Create an account", tick the Privacy Policy and Terms box, then continue with Google.',
        admin: 'That is an admin account. Please use the admin sign-in instead.',
        disabled: 'This account has been disabled. Please contact support.',
    };
    var ICON = {
        grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
        globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
        send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
        cash: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
        bot: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
        file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
        help: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
        sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
        menu: 'M3 12h18M3 6h18M3 18h18',
        store: 'M3 9l1-5h16l1 5M3 9v11h18V9M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6',
    };
    function toast(msg) { var t = el('div', { class: 'toast', text: msg }); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
    function waLink(text) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text); }
    function fmtDate(v) { try { return new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
    function pill(text, cls) { return el('span', { class: 'pill ' + (cls || ''), text: text }); }
    function head(kicker, title, sub) {
        return el('div', { class: 'head' }, [el('div', { class: 'kicker', text: kicker }), el('h1', { text: title }), sub ? el('p', { text: sub }) : null]);
    }
    function field(name, label, type, value, hint) {
        var input = type === 'textarea' ? el('textarea', { name: name }) :
            type === 'font' ? el('select', { name: name }, FONTS.map(function (f) { return el('option', { value: f, text: f || '(default)' }); })) :
            el('input', { name: name, type: type || 'text', autocomplete: 'off' });
        input.value = value || '';
        var err = el('div', { class: 'err' });
        return { wrap: el('div', {}, [el('label', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null, err]), input: input, setError: function (m) { err.textContent = m || ''; } };
    }
    function pwField(name, label, placeholder) {
        var input = el('input', { name: name, type: 'password', autocomplete: 'new-password', placeholder: placeholder || '' });
        var toggle = el('button', { type: 'button', text: 'Show', onclick: function () {
            var show = input.type === 'password'; input.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show'; } });
        var err = el('div', { class: 'err' });
        return { wrap: el('div', {}, [el('label', { text: label }), el('div', { class: 'pwwrap' }, [input, toggle]), err]), input: input, setError: function (m) { err.textContent = m || ''; } };
    }
    function showFieldErrors(fields, res) { Object.keys(fields).forEach(function (k) { if (fields[k].setError) fields[k].setError((res.fields && res.fields[k]) || ''); }); }

    /* ---------- sign up / sign in ---------- */
    function authView(startRegistering, notice) {
        document.title = 'EPM site owner dashboard';
        clear(root);
        var registering = !!startRegistering;
        var name = field('name', 'Full name', 'text'), email = field('email', 'Email', 'email');
        var pw = pwField('password', 'Password', 'At least 10 characters'), pw2 = pwField('confirm', 'Confirm password', 'Re-enter your password');
        var terms = el('input', { type: 'checkbox', id: 'terms' });
        var termsErr = el('div', { class: 'err' }), msg = el('div', { class: 'err' });
        var title = el('h2'), sub = el('div', { class: 'sub' }), btn = el('button', { class: 'btn primary', style: 'width:100%;justify-content:center;margin-top:14px' });
        var sw = el('div', { class: 'switch' }), swLabel = el('span'), swBtn = el('button', { type: 'button' });
        sw.appendChild(swLabel); sw.appendChild(document.createTextNode(' ')); sw.appendChild(swBtn);
        var termsRow = el('label', { class: 'checkrow', for: 'terms' }, [terms, el('span', {}, [
            'I agree to the ', el('a', { href: MARKETING + '/privacy', target: '_blank', rel: 'noopener', text: 'Privacy Policy' }), ' and ',
            el('a', { href: MARKETING + '/terms', target: '_blank', rel: 'noopener', text: 'Terms of Service' })])]);

        var showForm = !S.google, gBtn = null;
        var emailToggle = el('button', { type: 'button', class: 'linkbtn', text: 'Sign up with email instead' });
        emailToggle.addEventListener('click', function () { showForm = true; sync(); });
        var formWrap = el('div', {}, [name.wrap, email.wrap, pw.wrap, pw2.wrap]);
        function sync() {
            var collapsed = registering && !!S.google && !showForm;
            formWrap.classList.toggle('hidden', collapsed); btn.classList.toggle('hidden', collapsed);
            emailToggle.classList.toggle('hidden', !(registering && !!S.google && !showForm));
            if (gBtn) gBtn.lastChild.textContent = registering ? 'Sign up with Google' : 'Continue with Google';
            title.textContent = registering ? 'Create account' : 'Welcome back';
            sub.textContent = registering ? 'Sign up to get started' : 'Sign in to your dashboard';
            btn.textContent = registering ? 'Create account' : 'Sign in';
            swLabel.textContent = registering ? 'Already have an account?' : 'New here?';
            swBtn.textContent = registering ? 'Log in' : 'Create an account';
            [name.wrap, pw2.wrap, termsRow, termsErr].forEach(function (n) { n.classList.toggle('hidden', !registering); });
            pw.input.autocomplete = registering ? 'new-password' : 'current-password';
            msg.textContent = '';
        }
        swBtn.addEventListener('click', function () { registering = !registering; sync(); });
        function submit() {
            msg.textContent = ''; termsErr.textContent = '';
            [name, email, pw, pw2].forEach(function (f) { f.setError(''); });
            if (registering) {
                var bad = false;
                if (name.input.value.trim().length < 2) { name.setError('Enter your full name.'); bad = true; }
                if (pw.input.value.length < 10) { pw.setError('Use at least 10 characters.'); bad = true; }
                if (pw2.input.value !== pw.input.value) { pw2.setError('Passwords do not match.'); bad = true; }
                if (!terms.checked) { termsErr.textContent = 'Please accept the Privacy Policy and Terms of Service.'; bad = true; }
                if (bad) return;
            }
            btn.disabled = true;
            api('/api/auth?action=' + (registering ? 'register' : 'login'), 'POST',
                { email: email.input.value, password: pw.input.value, name: name.input.value, accept_terms: registering ? terms.checked : undefined })
                .then(function (r) { btn.disabled = false; if (r.owner) boot(); else msg.textContent = r.error || 'Could not continue.'; });
        }
        terms.addEventListener('change', function () { termsErr.textContent = ''; });
        [name, email, pw, pw2].forEach(function (f) { f.input.addEventListener('input', function () { f.setError(''); msg.textContent = ''; }); });
        btn.addEventListener('click', submit);
        root.addEventListener('keydown', function onKey(e) { if (e.key === 'Enter' && root.contains(e.target) && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') submit(); });

        var promo = el('div', { class: 'auth-promo' }, [
            el('div', { class: 'brandmark' }, [el('i', { text: 'E' }), el('span', { text: 'EPM' })]),
            el('h1', {}, ['Your own Deriv trading platform, ', el('span', { text: 'under your brand.' })]),
            el('p', { text: 'Create your account, brand your site and go live in minutes. Free to start, no coding required.' }),
            el('ul', {}, [el('li', { text: 'Free address live the moment you create it' }), el('li', { text: 'Your name, logo, colours and typeface' }),
                el('li', { text: 'Earn commission on your clients\u2019 trading' })]),
        ]);
        var googleBlock = null;
        if (S.google) {
            gBtn = el('button', { type: 'button', class: 'btn google' }, [googleIcon(), el('span', { text: 'Continue with Google' })]);
            gBtn.addEventListener('click', function () {
                termsErr.textContent = '';
                if (registering && !terms.checked) { termsErr.textContent = 'Please accept the Privacy Policy and Terms of Service first.'; return; }
                location.href = '/api/google?start=1&terms=' + (registering && terms.checked ? '1' : '0');
            });
            googleBlock = el('div', {}, [el('div', { style: 'margin-top:14px' }, [gBtn]), el('div', { class: 'divider', text: 'or' }), emailToggle]);
        }
        var card = el('div', { class: 'card auth-card' }, [title, sub, termsRow, termsErr, googleBlock, formWrap, msg, btn, sw]);
        root.appendChild(el('div', { class: 'auth' }, [promo, card]));
        sync();
        if (notice) msg.textContent = notice;
    }

    /* ---------- shell ---------- */
    var NAV = [
        ['sites', 'Sites', 'grid'], ['domains', 'Domains', 'globe'], ['deployments', 'Deployments', 'send'],
        ['commissions', 'Commissions', 'cash'], ['bots', 'Trading bots', 'bot'], ['strategies', 'Strategies', 'file'],
        ['support', 'Support', 'help'], ['settings', 'Settings', 'sliders'],
    ];
    function mountShell() {
        clear(root);
        var nav = el('nav', { class: 'nav' }, NAV.map(function (n) {
            var a = el('a', { href: '#/' + n[0], 'data-route': n[0] }, [svg(ICON[n[2]]), el('span', { text: n[1] })]);
            if (n[3]) a.appendChild(el('span', { class: 'soon', text: 'SOON' }));
            return a;
        }));
        var user = el('div', { class: 'usercard' }, [el('b', { text: S.owner.name }), el('span', { text: 'Site owner' })]);
        sideEl = el('aside', { class: 'side' }, [el('div', { class: 'brandmark' }, [el('i', { text: 'E' }), el('span', { text: 'EPM' })]), nav, user]);
        scrimEl = el('div', { class: 'scrim hidden', onclick: closeMenu });
        var menu = el('button', { class: 'menu', 'aria-label': 'Menu', onclick: function () { sideEl.classList.add('open'); scrimEl.classList.remove('hidden'); } }, [svg(ICON.menu)]);
        whoEl = el('div', { class: 'who' }, [el('span', { class: 'lbl', text: 'Signed in ' }), el('b', { text: S.owner.name })]);
        var logout = el('button', { class: 'btn', text: 'Log out', onclick: function () { api('/api/auth?action=logout', 'POST').then(function () { S.owner = null; S.site = null; S.comm = null; S.lib = null; authView(false); }); } });
        viewEl = el('main', { id: 'view' });
        ['input', 'change'].forEach(function (t) { viewEl.addEventListener(t, function () { touched = true; }); });
        root.appendChild(el('div', { class: 'shell' }, [sideEl, el('div', { class: 'main' }, [el('div', { class: 'top' }, [menu, whoEl, logout]), viewEl])]));
        root.appendChild(scrimEl);
        nav.addEventListener('click', closeMenu);
    }
    function closeMenu() { if (sideEl) sideEl.classList.remove('open'); if (scrimEl) scrimEl.classList.add('hidden'); }

    function route(quiet) {
        if (!S.owner || !viewEl) return;
        // A newer version of this page was found in the background: take it on this click, unless you are typing.
        if (updateReady && !quiet && !formDirty()) { location.reload(); return; }
        var path = (location.hash || '#/sites').replace(/^#\//, '');
        var base = path.split('/')[0] || 'sites';
        var views = {
            'sites': sitesView, 'sites/new': function () { return siteForm(true); }, 'sites/edit': function () { return siteForm(false); },
            'domains': domainsView, 'deployments': deploymentsView, 'support': supportView, 'settings': settingsView,
            'commissions': commissionsView,
            'bots': botsView, 'strategies': strategiesView,
        };
        var render = views[path] || views[base] || sitesView;
        Array.prototype.forEach.call(sideEl.querySelectorAll('a'), function (a) { a.classList.toggle('on', a.getAttribute('data-route') === base); });
        var keep = window.pageYOffset;
        touched = false;
        clear(viewEl); viewEl.appendChild(render()); window.scrollTo(0, quiet ? keep : 0);
        var item = NAV.filter(function (n) { return n[0] === base; })[0];
        document.title = (item ? item[1] : 'Dashboard') + ' | EPM';
        if (!quiet) revalidate(false);
    }
    function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

    /* ---------- pages ---------- */
    function supportBanner() {
        return el('div', { class: 'banner' }, [
            el('div', {}, [el('b', { text: 'Facing a challenge? Reach out to us' }), el('span', { text: 'We are here to help you get your site up and running.' })]),
            el('div', { class: 'row' }, [
                el('a', { class: 'btn green', href: waLink('Hello EPM, I need help with my site.'), target: '_blank', rel: 'noopener', text: 'Chat on WhatsApp' }),
                el('a', { class: 'btn', href: waLink('Hello EPM, please call me about my site.'), target: '_blank', rel: 'noopener', text: 'Request a call' })]),
        ]);
    }

    function renewalBanner() {
        var site = S.site, r = site && site.renewal;
        if (!r || (r.state === 'ok' && !r.paused)) return null;
        var date = new Date(r.expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
        var text = r.paused ? 'Your domain ' + site.domain + ' expired on ' + date + ' and your site is paused. Renew it to bring your site back.'
            : 'Your domain ' + site.domain + ' expires on ' + date + ' (' + r.days_left + (r.days_left === 1 ? ' day' : ' days') + ' left). Renew it to keep your site online.';
        return el('div', { class: 'notice ' + (r.paused || r.days_left <= 7 ? 'bad' : '') }, [el('div', { text: text }),
            el('button', { class: 'btn primary', type: 'button', text: 'Renew now', onclick: function () { S.domainTab = 'renew'; go('#/domains'); } })]);
    }
    function moneyText(n) { return Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 }); }
    // Follows an order after the payment prompt is sent, until it is finished or we give up waiting.
    function watchOrder(id, tries, say, btn) {
        api('/api/domains?order=' + id).then(function (x) {
            var o = x && x.order;
            if (!o) { say('We could not check your payment. Please refresh the page in a minute.', 'bad'); return; }
            if (o.status === 'completed') { say(o.message, 'ok'); toast(o.kind === 'renewal' ? 'Domain renewed' : 'Domain registered'); loadSite().then(function () { setTimeout(function () { S.domainTab = 'yours'; go('#/domains'); route(); }, 1500); }); return; }
            if (['cancelled', 'expired', 'refund_due', 'refunded', 'check_needed'].indexOf(o.status) >= 0) { say(o.message, o.status === 'check_needed' ? '' : 'bad'); btn.disabled = false; return; }
            say(o.message);
            if (tries > 0) setTimeout(function () { watchOrder(id, tries - 1, say, btn); }, 4000);
            else { say('Still waiting. If you paid, this page will update within a few minutes.', ''); btn.disabled = false; }
        });
    }

    /* ---------- illustrative market charts (sample shapes only, never real prices) ---------- */
    var SVGNS = 'http://www.w3.org/2000/svg', mkId = 0;
    function nsEl(tag, attrs) {
        var e = document.createElementNS(SVGNS, tag);
        Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
        return e;
    }
    function rng(seed) { // small seeded generator, so the charts look the same every time
        return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }
    function sparkSvg(seed, drift) {
        var r = rng(seed), y = 50, vals = [], i, W = 120, H = 44, pad = 3;
        for (i = 0; i < 30; i++) { y += (r() - 0.5) * 14 + drift; vals.push(y); }
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = (max - min) || 1;
        var pts = vals.map(function (v, k) { return [(k / (vals.length - 1)) * W, H - pad - ((v - min) / span) * (H - pad * 2)]; });
        var line = pts.map(function (q, k) { return (k ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' ');
        var up = vals[vals.length - 1] >= vals[0], col = up ? '#19a57a' : '#d9534f', id = 'mkg' + (++mkId);
        var s = nsEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true', 'class': 'mkt-line' });
        var defs = nsEl('defs'), g = nsEl('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' });
        g.appendChild(nsEl('stop', { offset: '0', 'stop-color': col, 'stop-opacity': '0.28' }));
        g.appendChild(nsEl('stop', { offset: '1', 'stop-color': col, 'stop-opacity': '0' }));
        defs.appendChild(g); s.appendChild(defs);
        s.appendChild(nsEl('path', { d: line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z', fill: 'url(#' + id + ')', stroke: 'none' }));
        s.appendChild(nsEl('path', { d: line, fill: 'none', stroke: col, 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke', pathLength: '1', 'class': 'ln' }));
        return s;
    }
    function candleSvg(seed) {
        var r = rng(seed), n = 26, W = 260, H = 110, price = 55, cs = [], i;
        for (i = 0; i < n; i++) {
            var o = price, c = o + (r() - 0.46) * 12;
            cs.push({ o: o, c: c, hi: Math.max(o, c) + r() * 5, lo: Math.min(o, c) - r() * 5 }); price = c;
        }
        var min = Math.min.apply(null, cs.map(function (k) { return k.lo; })), max = Math.max.apply(null, cs.map(function (k) { return k.hi; })), span = (max - min) || 1;
        function Y(v) { return 6 + (H - 12) * (1 - (v - min) / span); }
        var step = W / n, s = nsEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        for (i = 1; i < 4; i++) s.appendChild(nsEl('line', { x1: '0', x2: String(W), y1: String(H * i / 4), y2: String(H * i / 4), stroke: '#eee8d8', 'stroke-width': '1', 'vector-effect': 'non-scaling-stroke' }));
        cs.forEach(function (k, idx) {
            var x = (idx + 0.5) * step, col = k.c >= k.o ? '#19a57a' : '#d9534f';
            s.appendChild(nsEl('line', { x1: x.toFixed(1), x2: x.toFixed(1), y1: Y(k.hi).toFixed(1), y2: Y(k.lo).toFixed(1), stroke: col, 'stroke-width': '1.2', 'vector-effect': 'non-scaling-stroke' }));
            s.appendChild(nsEl('rect', { x: (x - step * 0.3).toFixed(1), width: (step * 0.6).toFixed(1), y: Y(Math.max(k.o, k.c)).toFixed(1), height: Math.max(1.5, Math.abs(Y(k.o) - Y(k.c))).toFixed(1), rx: '1', fill: col }));
        });
        var ma = cs.map(function (k, idx) { // 5-candle moving average, in the brand gold
            var a = cs.slice(Math.max(0, idx - 4), idx + 1), m = a.reduce(function (t, z) { return t + z.c; }, 0) / a.length;
            return (idx ? 'L' : 'M') + ((idx + 0.5) * step).toFixed(1) + ' ' + Y(m).toFixed(1); }).join(' ');
        s.appendChild(nsEl('path', { d: ma, fill: 'none', stroke: '#c9a24b', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
        return s;
    }
    function marketStrip() {
        var tiles = [['Volatility 100', 11, 1.1], ['Volatility 50', 27, 0.5], ['Boom 1000', 42, 1.6], ['Crash 1000', 58, -1.4]];
        var grid = el('div', { class: 'mkt-grid' }, tiles.map(function (t) {
            return el('div', { class: 'mkt-tile' }, [el('b', { text: t[0] }), el('small', { text: 'Synthetic index' }), sparkSvg(t[1], t[2])]);
        }));
        return el('div', { class: 'card mkt', role: 'img', 'aria-label': 'Illustrative market charts, not live prices' }, [
            el('div', { class: 'mkt-head' }, [el('h2', { text: 'Market watch' }), el('span', { class: 'mkt-tag', text: 'Illustrative \u00b7 not live prices' })]),
            grid, el('div', { class: 'mkt-candles' }, [candleSvg(7)]),
            el('p', { class: 'muted small', style: 'margin:8px 0 0', text: 'Sample charts for illustration only. They are not real prices and not trading advice.' })]);
    }

    function sitesView() {
        var v = el('div'), site = S.site;
        v.appendChild(el('div', { class: 'row between' }, [head('Welcome ' + S.owner.name.split(' ')[0], 'Your sites'),
            site ? null : el('a', { class: 'btn primary', href: '#/sites/new', text: 'Create new site' })]));
        v.appendChild(supportBanner());
        v.appendChild(renewalBanner());
        if (!site) {
            v.appendChild(el('div', { class: 'card empty' }, [el('div', { class: 'bubble' }, [svg(ICON.store)]),
                el('h2', {}, ['No sites yet.', el('span', { text: 'Let\u2019s build your first one!' })]),
                el('p', { text: 'Choose a free address that goes live instantly, or connect your own domain. Add your branding and you are ready.' }),
                el('a', { class: 'btn primary', href: '#/sites/new', text: '+ Create your first site' })]));
            v.appendChild(marketStrip());
            return v;
        }
        var card = el('div', { class: 'card' }, [
            el('div', { class: 'row between' }, [el('h2', { text: site.name }), el('div', { class: 'row' }, [pill(site.status, site.status), pill(site.plan === 'free' ? 'Free address' : 'Own domain')])]),
            el('p', { class: 'muted', style: 'margin:2px 0 10px' }, [site.domain]),
        ]);
        card.appendChild(el('p', { style: 'margin:0 0 12px' }, ['Markup ', el('b', { text: Number(site.markup_percent).toFixed(2) + '%' }), ' \u00b7 App ID ', site.app_id ? el('b', { text: site.app_id }) : pill('Awaiting assignment', 'pending')]));
        if (!site.app_id) card.appendChild(el('div', { class: 'notice', text: 'We are setting up your own Deriv app for this site. Your earnings are tracked separately once your App ID is assigned, and we will show it here.' }));
        if (site.status === 'pending') card.appendChild(el('div', { class: 'notice', text: 'Waiting for approval. Your site goes live once your domain is set up and reviewed.' }));
        if (site.status === 'suspended' && !(site.renewal && site.renewal.paused)) card.appendChild(el('div', { class: 'notice bad', text: 'This site is suspended. Please contact support.' }));
        var actions = el('div', { class: 'row' });
        if (site.status === 'active') actions.appendChild(el('a', { class: 'btn primary', href: 'https://' + site.domain, target: '_blank', rel: 'noopener', text: 'Open site' }));
        actions.appendChild(el('a', { class: 'btn', href: '#/sites/edit', text: 'Edit details' }));
        actions.appendChild(el('a', { class: 'btn', href: '#/domains', text: 'Domain' }));
        card.appendChild(actions);
        v.appendChild(card);
        return v;
    }

    // Markup picker: buttons only (steps of 0.5%), so values land on the tiers you stock apps for.
    function markupField(initial, locked, note) {
        var input = el('input', { name: 'markup_percent', type: 'text', readonly: 'readonly', autocomplete: 'off', 'aria-label': 'Markup percentage' });
        input.value = Number(initial).toFixed(2);
        var err = el('div', { class: 'err' });
        function clamp(n) { return Math.min(3, Math.max(1, Math.round(n * 2) / 2)); }
        function bump(d) { var n = parseFloat(input.value); if (!isFinite(n)) n = 1; input.value = clamp(n + d).toFixed(2); err.textContent = ''; }
        var minus = el('button', { type: 'button', class: 'stepbtn', 'aria-label': 'Decrease markup', text: '−', onclick: function () { bump(-0.5); } });
        var plus = el('button', { type: 'button', class: 'stepbtn', 'aria-label': 'Increase markup', text: '+', onclick: function () { bump(0.5); } });
        if (locked) { minus.disabled = true; plus.disabled = true; }
        var hint = locked
            ? 'Your markup is fixed by your Deriv app. Contact support if you want it changed.'
            : 'The extra percentage added on your clients’ trades, from 1 to 3%. It is what earns commission. A higher markup earns more but makes trading costlier for your clients. Use the buttons to change it in steps of 0.5%.' + (note ? ' ' + note : '');
        var wrap = el('div', {}, [el('label', { text: 'Markup percentage' }),
            el('div', { class: 'stepper' }, [minus, input, el('span', { class: 'pct', text: '%' }), plus]),
            el('div', { class: 'muted small', text: hint }), err]);
        return { wrap: wrap, input: input, locked: !!locked, setError: function (m) { err.textContent = m || ''; } };
    }

    function siteForm(creating) {
        var site = S.site;
        if (creating && site) { return el('div', {}, [head('Sites', 'Create a site'), el('div', { class: 'card' }, [el('p', { text: 'You already have a site. Each account has one site.' }), el('a', { class: 'btn', href: '#/sites', text: 'Back to sites' })])]); }
        if (!creating && !site) { return el('div', {}, [head('Sites', 'Edit site'), el('div', { class: 'card' }, [el('p', { text: 'Create your site first.' }), el('a', { class: 'btn primary', href: '#/sites/new', text: 'Create site' })])]); }
        var v = el('div'), fields = {}, isCustom = site ? site.plan === 'custom' : false;
        var root_ = S.freeRoot || 'your-domain';
        v.appendChild(head('Sites', creating ? 'Create a new site' : 'Edit ' + site.name));

        var contactBox;
        if (creating) {
            var free = el('input', { type: 'radio', name: 'plan', value: 'free', checked: 'checked', style: 'width:auto' });
            var cust = el('input', { type: 'radio', name: 'plan', value: 'custom', style: 'width:auto' });
            var subF = field('subdomain', 'Free address (just the name, e.g. julias)', 'text', '', 'Live at once at <name>.' + root_ + '. The platform handles customer support.');
            subF.input.setAttribute('placeholder', 'yourname');
            var domF = field('custom_domain', 'Your own domain', 'text', '', 'e.g. trade.yourbrand.com. Needs approval. You set your own support contacts.');
            domF.wrap.classList.add('hidden');
            var flip = function () { isCustom = cust.checked; domF.wrap.classList.toggle('hidden', !isCustom); subF.wrap.classList.toggle('hidden', isCustom); contactBox.classList.toggle('hidden', !isCustom); };
            free.addEventListener('change', flip); cust.addEventListener('change', flip);
            fields.subdomain = subF; fields.custom_domain = domF;
            v.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Choose your address' }),
                el('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:center' }, [free, 'Free address (live immediately)']),
                el('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:center' }, [cust, 'My own domain (after approval)']), subF.wrap, domF.wrap]));
            var mkF = markupField(1); fields.markup_percent = mkF;
            v.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Your markup' }), mkF.wrap]));
        }
        if (!creating && site) {
            var mkE = markupField(site.markup_percent, site.markup_locked, site.app_auto ? 'If you change it, your Deriv app is updated for you straight away.' : site.app_id ? 'If you change it, our team updates it on your Deriv app.' : 'Your site gets its own Deriv app for the markup you pick.'); fields.markup_percent = mkE;
            v.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Markup and App ID' }), mkE.wrap,
                el('p', { class: 'muted small', style: 'margin:12px 0 0', text: site.app_id ? 'Your App ID is ' + site.app_id + '.' : 'Your App ID has not been assigned yet.' })]));
        }
        var brand = el('div', { class: 'card' }, [el('h2', { text: 'Branding' })]);
        [['name', 'Site name', 'text'], ['logo_url', 'Logo URL (https://\u2026)', 'text'], ['primary_color', 'Main colour (#rrggbb)', 'text'], ['font', 'Font', 'font'],
            ['about', 'About', 'textarea'], ['vision', 'Vision', 'textarea'], ['mission', 'Mission', 'textarea']].forEach(function (d) {
            var f = field(d[0], d[1], d[2], site ? site[d[0]] : ''); fields[d[0]] = f; brand.appendChild(f.wrap);
        });
        v.appendChild(brand);
        contactBox = el('div', { class: 'card' }, [el('h2', { text: 'Support contacts' }), el('p', { class: 'muted small', text: 'Shown to your clients on your own domain. Leave blank to hide.' })]);
        [['whatsapp', 'WhatsApp (with country code)', 'text'], ['phone', 'Phone', 'text'], ['support_email', 'Support email', 'email'], ['telegram', 'Telegram username', 'text']].forEach(function (d) {
            var f = field(d[0], d[1], d[2], site ? site[d[0]] : ''); fields[d[0]] = f; contactBox.appendChild(f.wrap);
        });
        contactBox.classList.toggle('hidden', !isCustom);
        v.appendChild(contactBox);

        var msg = el('div', { class: 'err' }), save = el('button', { class: 'btn primary', text: creating ? 'Create my site' : 'Save changes' });
        save.addEventListener('click', function () {
            var body = {}; Object.keys(fields).forEach(function (k) { body[k] = fields[k].input.value; });
            if (creating && !isCustom) delete body.custom_domain;
            if (creating && isCustom) delete body.subdomain;
            if (!creating && fields.markup_percent && fields.markup_percent.locked) delete body.markup_percent;
            save.disabled = true; msg.textContent = '';
            api('/api/my-site', creating ? 'POST' : 'PUT', body).then(function (r) {
                save.disabled = false; showFieldErrors(fields, r);
                if (r.site) { S.site = r.site; loadSite().then(function () { toast(creating ? 'Site created.' : 'Changes saved.'); go('#/sites'); }); }
                else msg.textContent = r.error || '';
            });
        });
        v.appendChild(el('div', { class: 'row' }, [save, el('a', { class: 'btn ghost', href: '#/sites', text: 'Cancel' }), msg]));
        return v;
    }

    function dnsInstructions(domain) {
        var out = el('div', { class: 'card' }, [el('h2', { text: 'Point ' + domain + ' at your platform' }),
            el('p', { class: 'muted', text: 'Add ONE of these records where you manage your domain (your registrar or DNS provider):' })]);
        var t = el('table'), th = el('tr', {}, ['Use when', 'Type', 'Host', 'Value'].map(function (h) { return el('th', { text: h }); }));
        t.appendChild(th);
        t.appendChild(el('tr', {}, [el('td', { text: 'A subdomain, e.g. trade.yourbrand.com' }), el('td', { text: 'CNAME' }), el('td', {}, [el('code', { text: 'trade' }), ' (the part before your domain)']), el('td', {}, [el('code', { text: S.dns.cname })])]));
        t.appendChild(el('tr', {}, [el('td', { text: 'A main domain, e.g. yourbrand.com' }), el('td', { text: 'A' }), el('td', {}, [el('code', { text: '@' })]), el('td', {}, [el('code', { text: S.dns.a })])]));
        out.appendChild(el('div', { style: 'overflow-x:auto' }, [t]));
        out.appendChild(el('p', { class: 'muted small', text: 'If you use Cloudflare, set the record to "DNS only" (grey cloud). Changes can take from a few minutes to a few hours to spread.' }));
        var result = el('div'), btn = el('button', { class: 'btn', text: 'Check DNS' });
        btn.addEventListener('click', function () {
            btn.disabled = true; clear(result);
            api('/api/my-site?check_dns=1').then(function (r) {
                btn.disabled = false;
                if (r.dns_check) {
                    result.appendChild(el('div', { class: 'notice ' + (r.dns_check.pointing ? 'ok' : '') },
                        [r.dns_check.pointing ? r.dns_check.domain + ' is pointing at the platform.' : r.dns_check.domain + ' is not pointing at the platform yet. DNS can take a while to update; check again shortly.']));
                } else result.appendChild(el('div', { class: 'notice bad', text: r.error || 'Could not check.' }));
            });
        });
        out.appendChild(el('div', { class: 'row' }, [btn])); out.appendChild(result);
        return out;
    }

    function domainsView() {
        var v = el('div'), site = S.site;
        v.appendChild(head('Infrastructure', 'Domains', 'Your platform address, your own domains, and buying a new one.'));
        if (!site) { v.appendChild(el('div', { class: 'card' }, [el('p', { text: 'Create a site first, then you can connect or buy a domain.' }), el('a', { class: 'btn primary', href: '#/sites/new', text: 'Create site' })])); return v; }

        var TABS = [['yours', 'Your address'], ['buy', 'Buy a domain'], ['own', 'Connect your own'], ['history', 'Payment history']];
        if (site.renewal) TABS.splice(1, 0, ['renew', 'Renew']);
        if (cur0() === 'renew' && !site.renewal) S.domainTab = 'yours';
        var cur = S.domainTab || 'yours';
        function cur0() { return S.domainTab; }
        v.appendChild(renewalBanner());
        var tabBar = el('div', { class: 'tabs', role: 'tablist' }, TABS.map(function (t) {
            return el('button', { type: 'button', role: 'tab', class: 'tab' + (t[0] === cur ? ' on' : ''), 'aria-selected': t[0] === cur ? 'true' : 'false', text: t[1],
                onclick: function () { S.domainTab = t[0]; route(); } });
        }));
        v.appendChild(tabBar);
        var body = el('div');
        v.appendChild(body);

        if (cur === 'yours') {
            body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Your address' }),
                el('div', { class: 'row' }, [el('strong', { text: site.domain }), pill(site.status, site.status), pill(site.plan === 'free' ? 'Free address' : 'Own domain')]),
                el('p', { class: 'muted small', text: site.plan === 'free' ? 'The platform handles support for your clients.' : 'You handle support for your own clients.' })]));
            if (site.plan !== 'free') body.appendChild(dnsInstructions(site.domain));
        }

        if (cur === 'own') {
            if (site.plan === 'free') {
                if (site.custom_domain_requested) {
                    body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Own domain requested' }), el('p', {}, ['You asked to move to ', el('strong', { text: site.custom_domain_requested }), '. We activate it after review once the DNS record below is in place.'])]));
                    body.appendChild(dnsInstructions(site.custom_domain_requested));
                } else {
                    var d = field('domain', 'Your domain', 'text', '', 'e.g. trade.yourbrand.com. Moving to your own domain needs our approval.');
                    var m = el('div', { class: 'err' });
                    body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Connect a domain you already own' }), d.wrap,
                        el('button', { class: 'btn primary', text: 'Request my own domain', onclick: function () {
                            m.textContent = '';
                            api('/api/my-site', 'PUT', { action: 'request_custom_domain', domain: d.input.value }).then(function (r) {
                                if (r.site) { loadSite().then(function () { toast('Request sent.'); route(); }); } else m.textContent = r.error || 'Could not send the request.'; }); } }), m]));
                }
            } else {
                body.appendChild(dnsInstructions(site.domain));
            }
        }

        if (cur === 'buy') {
            var q = el('input', { type: 'text', name: 'domain-search', placeholder: 'Type the name you want, e.g. mybrandtrading', autocomplete: 'off', spellcheck: 'false' });
            var out = el('div', { class: 'muted small', style: 'margin-top:12px' });
            function checkout(d, r) {
                var money = function (n) { return Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 }); };
                var price = r.kes_available && d.price_kes ? 'KES ' + money(d.price_kes) : null;
                var renew = r.kes_available && d.renewal_kes ? 'KES ' + money(d.renewal_kes) : '$' + Number(d.renewal_usd).toFixed(2);
                clear(out);
                if (!price) { out.appendChild(el('div', { class: 'notice bad', text: 'Shilling prices are not available right now, so buying is paused. Please try again later.' })); return; }
                var f = { phone: field('phone', 'Your M-Pesa number', 'tel', '', 'The number that will get the payment prompt, for example 0712345678.'),
                    first_name: field('first_name', 'First name', 'text', ''), last_name: field('last_name', 'Last name', 'text', ''),
                    address1: field('address1', 'Street address', 'text', ''), city: field('city', 'Town or city', 'text', ''),
                    state: field('state', 'County or region', 'text', ''), zip: field('zip', 'Postal code', 'text', '', 'Use 00100 if you are not sure.'),
                    country: field('country', 'Country code', 'text', 'KE', 'Two letters, for example KE.') };
                var msg = el('div', { class: 'notice', style: 'display:none' });
                var payBtn = el('button', { class: 'btn primary', type: 'button', text: 'Pay ' + price + ' with M-Pesa' });
                var back = el('button', { class: 'btn', type: 'button', text: 'Back', onclick: search });
                var box = el('div', { class: 'card', style: 'margin-top:8px' }, [
                    el('h3', { text: d.domain }),
                    el('p', {}, [el('strong', { text: price }), ' for the first year. It renews at ', el('strong', { text: renew }), ' a year after that. We do not renew it for you: you will be reminded, and your site pauses if you do not renew.']),
                    el('p', { class: 'muted small', text: 'The registry needs the owner\u2019s details. Use your real details.' }),
                    f.first_name.wrap, f.last_name.wrap, f.address1.wrap, f.city.wrap, f.state.wrap, f.zip.wrap, f.country.wrap, f.phone.wrap, msg,
                    el('div', { class: 'row' }, [payBtn, back])]);
                out.appendChild(box);
                function say(text, kind) { msg.style.display = text ? '' : 'none'; msg.className = 'notice ' + (kind || ''); msg.textContent = text || ''; }
                payBtn.addEventListener('click', function () {
                    Object.keys(f).forEach(function (k) { f[k].setError(''); });
                    var body = { action: 'order', domain: d.domain, phone: f.phone.input.value, contact: {} };
                    ['first_name', 'last_name', 'address1', 'city', 'state', 'zip', 'country'].forEach(function (k) { body.contact[k] = f[k].input.value; });
                    payBtn.disabled = true; say('Sending the payment prompt to your phone\u2026');
                    api('/api/domains', 'POST', body).then(function (x) {
                        if (!x || !x.order) {
                            payBtn.disabled = false;
                            var fl = (x && x.fields) || {};
                            Object.keys(fl).forEach(function (k) { if (f[k]) f[k].setError(fl[k]); });
                            say((x && x.error) || 'Something went wrong. Please try again.', 'bad'); return;
                        }
                        say(x.order.message);
                        watchOrder(x.order.id, 45, say, payBtn);
                    });
                });
            }
            function search() {
                var name = String(q.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
                var label = name.split('.')[0];
                clear(out);
                if (!label) { out.textContent = 'Type a name to search.'; return; }
                if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) { out.textContent = 'Use only letters, numbers and hyphens, with no spaces, and do not start or end with a hyphen.'; return; }
                out.appendChild(el('p', { text: 'Searching\u2026' }));
                api('/api/domains?name=' + encodeURIComponent(label)).then(function (r) {
                    clear(out);
                    if (!r || !r.results) { out.appendChild(el('div', { class: 'notice bad', text: (r && r.error) || 'Could not search. Please try again.' })); return; }
                    var money = function (n) { return Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 }); };
                    var usd = function (n) { return '$' + Number(n).toFixed(2); };
                    r.results.forEach(function (d) {
                        var right;
                        if (!d.available) right = el('span', { class: 'muted small', text: 'Taken' });
                        else if (!d.offered) right = el('span', { class: 'muted small', text: d.reason || 'Not available here' });
                        else {
                            var first = r.kes_available && d.price_kes ? 'KES ' + money(d.price_kes) : usd(d.price_usd);
                            var renew = r.kes_available && d.renewal_kes ? 'KES ' + money(d.renewal_kes) : usd(d.renewal_usd);
                            var jump = d.renewal_usd > d.price_usd * 1.5;
                            right = el('div', {}, [
                                el('div', {}, [el('strong', { text: first }), el('span', { class: 'muted small', text: ' for the first year' + (r.kes_available ? ' (' + usd(d.price_usd) + ')' : '') })]),
                                el('div', { class: jump ? 'err small' : 'muted small', text: 'Renews at ' + renew + ' a year after that.' }),
                                el('button', { class: 'btn primary', type: 'button', text: 'Buy this domain', onclick: function () { checkout(d, r); } })]);
                        }
                        out.appendChild(el('div', { class: 'card', style: 'margin-top:8px' }, [el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [el('strong', { text: d.domain }), right])]));
                    });
                    if (!r.kes_available) out.appendChild(el('p', { class: 'muted small', text: 'Prices are shown in US dollars for now. Payment is by M-Pesa in shillings.' }));
                    out.appendChild(el('p', { class: 'muted small', text: 'Nothing is charged by searching. You pay by M-Pesa only after you confirm.' }));
                });
            }
            q.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
            body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Find a domain' }),
                el('p', { class: 'muted small', text: 'Search for a name, pick one, pay by M-Pesa, and we connect it to your site. Buying a domain moves you to the own-domain plan.' }),
                el('div', { class: 'row' }, [q, el('button', { class: 'btn primary', text: 'Search', onclick: search })]), out]));
            body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'How buying will work' }),
                el('ol', { class: 'muted small' }, [el('li', { text: 'Search a name and see the price.' }), el('li', { text: 'Pay by M-Pesa. Your payment is confirmed automatically.' }),
                    el('li', { text: 'We register the domain and connect it to your site. No DNS work needed.' }), el('li', { text: 'The purchase appears under Payment history.' })])]));
        }

        if (cur === 'history') {
            var hbox = el('div', { class: 'card' }, [el('h2', { text: 'Payment history' }), el('p', { class: 'muted', text: 'Loading\u2026' })]);
            body.appendChild(hbox);
            api('/api/domains?orders=1').then(function (r) {
                clear(hbox); hbox.appendChild(el('h2', { text: 'Payment history' }));
                var list = (r && r.orders) || [];
                if (!list.length) { hbox.appendChild(el('p', { class: 'muted', text: 'No domain payments yet. Purchases and renewals will be listed here.' })); return; }
                list.forEach(function (o) {
                    hbox.appendChild(el('div', { class: 'row between', style: 'padding:8px 0;border-top:1px solid var(--line, #e5e7eb)' }, [
                        el('div', {}, [el('strong', { text: o.domain }), el('div', { class: 'muted small', text: (o.kind === 'renewal' ? 'Renewal' : 'Purchase') + ' \u00b7 ' + new Date(o.created_at).toLocaleDateString('en-KE') + (o.receipt ? ' \u00b7 ' + o.receipt : '') })]),
                        el('div', { style: 'text-align:right' }, [el('div', { text: 'KES ' + moneyText(o.price_kes) }), el('div', { class: 'muted small', text: o.status.replace(/_/g, ' ') })])]));
                });
            });
        }

        if (cur === 'renew') {
            var rbox = el('div', { class: 'card' }, [el('h2', { text: 'Renew your domain' }), el('p', { class: 'muted', text: 'Loading\u2026' })]);
            body.appendChild(rbox);
            api('/api/domains?renewal=1').then(function (r) {
                clear(rbox); rbox.appendChild(el('h2', { text: 'Renew your domain' }));
                if (!r || r.error) { rbox.appendChild(el('div', { class: 'notice bad', text: (r && r.error) || 'Could not load the renewal price.' })); return; }
                var date = new Date(r.expires_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
                rbox.appendChild(el('p', {}, [el('strong', { text: r.domain }), r.paused ? ' expired on ' + date + '. Your site is paused until you renew.' : ' expires on ' + date + '.']));
                if (!r.can_renew) { rbox.appendChild(el('p', { class: 'muted', text: 'You can renew in the last 90 days before it expires. We will remind you here.' })); return; }
                if (!r.kes_available) { rbox.appendChild(el('div', { class: 'notice bad', text: 'Shilling prices are not available right now, so renewing is paused. Please try again later.' })); return; }
                var phone = field('phone', 'Your M-Pesa number', 'tel', '', 'The number that will get the payment prompt, for example 0712345678.');
                var rmsg = el('div', { class: 'notice', style: 'display:none' });
                var pay = el('button', { class: 'btn primary', type: 'button', text: 'Pay KES ' + moneyText(r.price_kes) + ' with M-Pesa' });
                function say2(text, kind) { rmsg.style.display = text ? '' : 'none'; rmsg.className = 'notice ' + (kind || ''); rmsg.textContent = text || ''; }
                pay.addEventListener('click', function () {
                    phone.setError(''); pay.disabled = true; say2('Sending the payment prompt to your phone\u2026');
                    api('/api/domains', 'POST', { action: 'renew', phone: phone.input.value }).then(function (x) {
                        if (!x || !x.order) { pay.disabled = false; if (x && x.fields && x.fields.phone) phone.setError(x.fields.phone); say2((x && x.error) || 'Something went wrong. Please try again.', 'bad'); return; }
                        say2(x.order.message); watchOrder(x.order.id, 45, say2, pay);
                    });
                });
                rbox.appendChild(el('p', {}, [el('strong', { text: 'KES ' + moneyText(r.price_kes) }), ' for one more year.']));
                rbox.appendChild(phone.wrap); rbox.appendChild(rmsg); rbox.appendChild(el('div', { class: 'row' }, [pay]));
                if (r.rate_credit) rbox.appendChild(el('p', { class: 'muted small' }, ['Rates By ', el('a', { href: 'https://www.exchangerate-api.com', target: '_blank', rel: 'noopener noreferrer', text: 'Exchange Rate API' }), '.']));
            });
        }
        return v;
    }

    /* ---------- commissions ---------- */
    // Shows only the operator's own earnings in US dollars. The server never sends markup, volume or either share.
    function usd(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function monthName(m) { try { return new Date(m + '-01T00:00:00Z').toLocaleString([], { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return m; } }
    function dayName(d) { try { return new Date(d + 'T00:00:00Z').toLocaleDateString([], { dateStyle: 'medium', timeZone: 'UTC' }); } catch (e) { return d; } }
    function statBox(label, value) { return el('div', { class: 'stat' }, [el('small', { text: label }), el('b', { text: value })]); }
    function simpleTable(headers, rows) {
        var t = el('table', {}, [el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))]);
        rows.forEach(function (cells) { t.appendChild(el('tr', {}, cells.map(function (c) { return el('td', {}, [typeof c === 'string' ? document.createTextNode(c) : c]); }))); });
        return el('div', { style: 'overflow-x:auto' }, [t]);
    }
    var REQUEST_STATUS = { requested: ['Waiting for payment', 'pending'], paid: ['Paid', 'active'], rejected: ['Rejected', 'suspended'], cancelled: ['Cancelled', ''] };

    function commissionsView() {
        var v = el('div'), tab = S.commTab || 'overview';
        v.appendChild(head('Revenue streams', 'Commissions', 'Your earnings, withdrawals and answers to common questions. Amounts are in US dollars.'));
        var TABS = [['overview', 'Overview'], ['history', 'History'], ['withdraw', 'Withdrawal'], ['faq', 'FAQ']];
        v.appendChild(el('div', { class: 'tabs', role: 'tablist' }, TABS.map(function (t) {
            return el('button', { type: 'button', role: 'tab', class: 'tab' + (t[0] === tab ? ' on' : ''), 'aria-selected': t[0] === tab ? 'true' : 'false', text: t[1],
                onclick: function () { S.commTab = t[0]; route(); } });
        })));
        var body = el('div');
        v.appendChild(body);
        function paint(d, later) {
            if (later && (!viewEl || !viewEl.contains(v))) return; // you moved to another page meanwhile
            clear(body);
            if (d.error || !d.summary) { body.appendChild(el('div', { class: 'notice bad', text: d.error || 'Could not load your earnings.' })); return; }
            ({ overview: commOverview, history: commHistory, withdraw: commWithdraw, faq: commFaq })[tab](body, d);
        }
        if (S.comm) paint(S.comm, false);                       // already in memory: shown at once
        else { body.appendChild(el('p', { class: 'muted', text: 'Loading…' })); api('/api/commissions').then(function (d) { paint(d, true); }); }
        return v;
    }

    function commOverview(body, d) {
        var s = d.summary;
        if (!S.site) body.appendChild(el('div', { class: 'notice', text: 'Create your site first. Earnings start once clients trade through it.' }));
        else if (!S.site.app_id) body.appendChild(el('div', { class: 'notice', text: 'Your site is waiting for its Deriv App ID. Earnings are counted once it is assigned.' }));
        body.appendChild(el('div', { class: 'stats' }, [statBox('Available to withdraw', usd(s.available)), statBox('Awaiting Deriv payment', usd(s.pending)), statBox('Paid out', usd(s.paid))]));
        body.appendChild(el('div', { class: 'stats' }, [
            statBox('This month (' + monthName(s.this_month_label) + ')', usd(s.this_month)),
            statBox(s.latest_day ? 'Latest day (' + dayName(s.latest_day) + ')' : 'Latest day', usd(s.latest_day_amount)),
            statBox('Withdrawal requested', usd(s.requested))]));
        var card = el('div', { class: 'card' }, [el('h2', { text: 'How your earnings work' }),
            el('p', { class: 'muted', text: 'Your earnings come from your clients’ trading on your site and are updated once a day. A month’s earnings stay under "Awaiting Deriv payment" until Deriv has paid that month and we have confirmed it. Then they move to "Available to withdraw".' }),
            el('p', { class: 'muted small', text: s.last_updated ? 'Last updated ' + fmtDate(s.last_updated) + '.' : 'No earnings have been recorded yet.' }),
            el('button', { type: 'button', class: 'btn primary', text: 'Request a withdrawal', onclick: function () { S.commTab = 'withdraw'; route(); } })]);
        body.appendChild(card);
    }

    function commHistory(body, d) {
        var months = el('div', { class: 'card' }, [el('h2', { text: 'By month' })]);
        if (!d.months.length) months.appendChild(el('p', { class: 'muted', text: 'Nothing recorded yet. Your months will be listed here.' }));
        else months.appendChild(simpleTable(['Month', 'Earned', 'Status'], d.months.map(function (m) {
            return [monthName(m.month), usd(m.amount), pill(m.confirmed ? 'Confirmed' : 'Awaiting Deriv payment', m.confirmed ? 'active' : 'pending')];
        })));
        body.appendChild(months);
        var days = el('div', { class: 'card' }, [el('h2', { text: 'Daily earnings' }), el('p', { class: 'muted small', text: 'The last 90 days with earnings.' })]);
        if (!d.days.length) days.appendChild(el('p', { class: 'muted', text: 'No daily earnings yet.' }));
        else days.appendChild(simpleTable(['Day', 'Earned'], d.days.map(function (x) { return [dayName(x.day), usd(x.amount)]; })));
        body.appendChild(days);
    }

    function commWithdraw(body, d) {
        var s = d.summary, open = d.requests.filter(function (r) { return r.status === 'requested'; })[0];
        var amount = el('input', { type: 'text', name: 'amount', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 25.00' });
        var method = el('select', { name: 'method' }, [el('option', { value: 'mpesa', text: 'M-Pesa' }), el('option', { value: 'usdt', text: 'USDT' })]);
        var network = el('select', { name: 'network' }, [el('option', { value: '', text: 'Choose the network' }), el('option', { value: 'TRC20', text: 'TRC20 (Tron)' }), el('option', { value: 'ERC20', text: 'ERC20 (Ethereum)' }), el('option', { value: 'BEP20', text: 'BEP20 (BNB Smart Chain)' })]);
        var dest = el('input', { type: 'text', name: 'destination', autocomplete: 'off', spellcheck: 'false' });
        var errs = {}, wraps = {};
        function fieldBox(key, label, input, hint) {
            errs[key] = el('div', { class: 'err' });
            wraps[key] = el('div', {}, [el('label', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null, errs[key]]);
            return wraps[key];
        }
        var form = el('div', { class: 'card' }, [el('h2', { text: 'Request a withdrawal' }),
            el('p', { class: 'muted', text: 'Available to withdraw: ' + usd(s.available) + '. The smallest withdrawal is ' + usd(d.min_withdrawal) + '. You can have one request waiting at a time.' }),
            fieldBox('amount', 'Amount (US dollars)', amount), fieldBox('method', 'Pay me by', method),
            fieldBox('network', 'USDT network', network, 'Pick the network your wallet uses. A wrong network can lose the money.'),
            fieldBox('destination', 'M-Pesa number', dest)]);
        function sync() {
            var usdt = method.value === 'usdt';
            wraps.network.classList.toggle('hidden', !usdt);
            wraps.destination.querySelector('label').textContent = usdt ? 'Wallet address' : 'M-Pesa number';
            dest.setAttribute('placeholder', usdt ? 'Your USDT wallet address' : 'e.g. 0712 345 678');
        }
        method.addEventListener('change', sync); sync();
        var msg = el('div', { class: 'err' });
        var send = el('button', { class: 'btn primary', text: 'Request withdrawal' });
        if (open) { send.disabled = true; form.appendChild(el('div', { class: 'notice', text: 'You already have a request waiting. You can ask again once it is paid, or cancel it below.' })); }
        else if (s.available < d.min_withdrawal) { send.disabled = true; form.appendChild(el('div', { class: 'notice', text: 'You have nothing to withdraw yet. Earnings become available after Deriv has paid the month and we have confirmed it.' })); }
        send.addEventListener('click', function () {
            msg.textContent = ''; Object.keys(errs).forEach(function (k) { errs[k].textContent = ''; });
            send.disabled = true;
            api('/api/commissions', 'POST', { action: 'withdraw', amount: amount.value, method: method.value, network: method.value === 'usdt' ? network.value : undefined, destination: dest.value }).then(function (r) {
                send.disabled = false;
                if (r.summary) { toast('Withdrawal requested.'); route(); return; }
                Object.keys(r.fields || {}).forEach(function (k) { if (errs[k]) errs[k].textContent = r.fields[k]; });
                msg.textContent = r.fields ? '' : (r.error || 'Could not send the request.');
            });
        });
        form.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [send, msg]));
        body.appendChild(form);

        var list = el('div', { class: 'card' }, [el('h2', { text: 'Your withdrawals' })]);
        if (!d.requests.length) list.appendChild(el('p', { class: 'muted', text: 'No withdrawals yet.' }));
        else list.appendChild(simpleTable(['Requested', 'Amount', 'To', 'Status', 'Details'], d.requests.map(function (r) {
            var st = REQUEST_STATUS[r.status] || [r.status, ''];
            var detail = r.status === 'paid' ? ('Reference ' + r.reference) : r.status === 'rejected' ? (r.note || 'Not approved. Contact support.') : '';
            var cell = r.status === 'requested'
                ? el('button', { class: 'btn', text: 'Cancel', onclick: function () {
                    if (!confirm('Cancel this withdrawal request?')) return;
                    api('/api/commissions', 'POST', { action: 'cancel', id: r.id }).then(function (x) { if (x.summary) { toast('Request cancelled.'); route(); } else toast(x.error || 'Could not cancel.'); }); } })
                : detail;
            return [fmtDate(r.created_at), usd(r.amount), (r.method === 'mpesa' ? 'M-Pesa ' : 'USDT ' + r.network + ' ') + r.destination, pill(st[0], st[1]), cell];
        })));
        body.appendChild(list);
    }

    function commFaq(body, d) {
        var items = [
            ['How are my earnings worked out?', 'You earn your agreed share of the markup your clients’ trades generate on your site’s own Deriv app. Your share is set out in your agreement with EPM. Amounts are in US dollars and are updated once a day.'],
            ['Why is some money "Awaiting Deriv payment"?', 'Deriv pays partner commission monthly. A month’s earnings become available to withdraw once Deriv has paid that month and EPM has confirmed it. Until then the figures can still change.'],
            ['How do I get paid?', 'Open the Withdrawal tab, choose M-Pesa or USDT, and send a request. We check it and pay it out, then show the M-Pesa code or transaction hash next to your request.'],
            ['What is the smallest withdrawal?', 'The smallest withdrawal is ' + usd(d.min_withdrawal) + '. You can have one request waiting at a time.'],
            ['Which currency will I receive?', 'Amounts here are in US dollars. Ask us on WhatsApp which exchange rate applies to M-Pesa payouts.'],
            ['Why do I see no earnings?', 'Earnings are counted once your site has its own Deriv App ID and your clients trade through it. Check the Sites page for your App ID.'],
            ['Are my earnings guaranteed?', 'No. They depend on your clients’ trading and on Deriv’s reports, and trading carries a high risk of loss. Never promise profits to your clients.'],
        ];
        var faq = el('div', { class: 'card' }, [el('h2', { text: 'Commission questions' })]);
        items.forEach(function (q) { faq.appendChild(el('details', {}, [el('summary', { text: q[0] }), el('p', { text: q[1] })])); });
        body.appendChild(faq);
        body.appendChild(supportBanner());
    }

    /* ---------- trading bots, strategies, bot requests ---------- */
    var LIB_STATUS = { live: ['Live', 'active'], removed: ['Removed', 'suspended'] };
    var REQ_STATUS = { open: ['Waiting', 'pending'], done: ['Done', 'active'], declined: ['Declined', 'suspended'], cancelled: ['Cancelled', ''] };
    var CONTRACTS = ['Accumulators', 'Rise/Fall', 'Matches/Differs', 'Over/Under', 'Even/Odd', 'Multiplier', 'Other'];
    function sizeText(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
    function readFile(file, asBase64) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onerror = function () { reject(new Error('read')); };
            r.onload = function () { var v = String(r.result); resolve(asBase64 ? v.slice(v.indexOf(',') + 1) : v); };
            if (asBase64) r.readAsDataURL(file); else r.readAsText(file);
        });
    }
    // A labelled input with its own error line. Returns the wrapper and a setter for the message.
    function box(label, input, hint) {
        var err = el('div', { class: 'err' });
        return { wrap: el('div', {}, [el('label', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null, err]), input: input, setError: function (m) { err.textContent = m || ''; } };
    }
    function loadLibrary(v, body, render) {
        function paint(d, later) {
            if (later && (!viewEl || !viewEl.contains(v))) return; // you moved to another page meanwhile
            clear(body);
            if (d.error || !d.limits) { body.appendChild(el('div', { class: 'notice bad', text: d.error || 'Could not load this page.' })); return; }
            if (!d.site) { body.appendChild(el('div', { class: 'card empty' }, [el('h2', { text: 'Create your site first' }), el('p', { text: 'Bots and documents belong to your site.' }),
                el('button', { class: 'btn primary', text: 'Create new site', onclick: function () { go('#/sites/new'); } })])); return; }
            render(d);
        }
        if (S.lib) { paint(S.lib, false); return; }              // already in memory: shown at once
        body.appendChild(el('p', { class: 'muted', text: 'Loading…' }));
        api('/api/library').then(function (d) { paint(d, true); });
    }
    function tabBar(tabs, current, key) {
        return el('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (t) {
            return el('button', { type: 'button', role: 'tab', class: 'tab' + (t[0] === current ? ' on' : ''), 'aria-selected': t[0] === current ? 'true' : 'false', text: t[1],
                onclick: function () { S[key] = t[0]; route(); } });
        }));
    }

    function botsView() {
        var v = el('div'), tab = S.botTab || 'mine';
        v.appendChild(head('Algorithm marketplace', 'Trading bots', 'Add your own bots to your site, or ask us to build one for you.'));
        v.appendChild(tabBar([['mine', 'My bots'], ['request', 'Request a bot']], tab, 'botTab'));
        var body = el('div');
        v.appendChild(body);
        loadLibrary(v, body, function (d) { (tab === 'request' ? botRequests : myBots)(body, d); });
        return v;
    }

    function myBots(body, d) {
        var editing = S.editBot ? d.bots.filter(function (b) { return b.id === S.editBot; })[0] : null;
        if (S.editBot && !editing) S.editBot = null;
        var f = {
            name: box('Bot name', el('input', { type: 'text', name: 'name', maxlength: '120', autocomplete: 'off' })),
            description: box('What does it do?', el('textarea', { name: 'description', maxlength: '2000' })),
            market: box('Market', el('input', { type: 'text', name: 'market', maxlength: '80', autocomplete: 'off', placeholder: 'e.g. Volatility 100 (1s)' })),
            risk_level: box('Risk level', el('select', { name: 'risk_level' }, ['Low', 'Medium', 'High'].map(function (r) { return el('option', { value: r, text: r }); }))),
            contract_type: box('Contract type', el('select', { name: 'contract_type' }, CONTRACTS.map(function (c) { return el('option', { value: c, text: c }); }))),
            xml_content: box(editing ? 'Replace the bot file (optional)' : 'Bot file', el('input', { type: 'file', name: 'file', accept: '.xml,text/xml,application/xml' }),
                editing ? 'Leave this empty to keep the current file.' : 'Export your bot from Deriv Bot as an .xml file and choose it here.'),
        };
        if (editing) { f.name.input.value = editing.name; f.description.input.value = editing.description; f.market.input.value = editing.market; f.risk_level.input.value = editing.risk_level; f.contract_type.input.value = editing.contract_type; }
        else { f.risk_level.input.value = 'Medium'; f.contract_type.input.value = 'Other'; }
        var msg = el('div', { class: 'err' });
        var save = el('button', { class: 'btn primary', text: editing ? 'Save changes' : 'Add bot' });
        save.addEventListener('click', function () {
            Object.keys(f).forEach(function (k) { f[k].setError(''); }); msg.textContent = '';
            var file = f.xml_content.input.files && f.xml_content.input.files[0];
            if (!file && !editing) { f.xml_content.setError('Choose the bot file (.xml).'); return; }
            save.disabled = true;
            (file ? readFile(file, false) : Promise.resolve(undefined)).then(function (xml) {
                var payload = { action: editing ? 'update_bot' : 'add_bot', id: editing ? editing.id : undefined, name: f.name.input.value, description: f.description.input.value, market: f.market.input.value,
                    risk_level: f.risk_level.input.value, contract_type: f.contract_type.input.value, xml_content: xml };
                return api('/api/library', 'POST', payload);
            }).then(function (r) {
                save.disabled = false;
                if (r.bots) { S.editBot = null; toast(editing ? 'Bot updated.' : 'Bot added. It is live on your site.'); route(); return; }
                Object.keys(r.fields || {}).forEach(function (k) { if (f[k]) f[k].setError(r.fields[k]); });
                msg.textContent = r.fields ? '' : (r.error || 'Could not save the bot.');
            }).catch(function () { save.disabled = false; msg.textContent = 'Could not read that file.'; });
        });
        var actions = [save, msg];
        if (editing) actions.splice(1, 0, el('button', { class: 'btn', text: 'Cancel', onclick: function () { S.editBot = null; route(); } }));
        body.appendChild(el('div', { class: 'card' }, [el('h2', { text: editing ? 'Edit bot' : 'Add a bot' }),
            el('p', { class: 'muted', text: 'A bot is live on your site as soon as you add it, next to the EPM library. You are responsible for the bots you add, because visitors run them on their own accounts. We can remove any bot at any time.' }),
            f.name.wrap, f.description.wrap, f.market.wrap, f.risk_level.wrap, f.contract_type.wrap, f.xml_content.wrap,
            el('div', { class: 'row', style: 'margin-top:12px' }, actions)]));

        var list = el('div', { class: 'card' }, [el('h2', { text: 'Your bots' })]);
        if (!d.bots.length) list.appendChild(el('p', { class: 'muted', text: 'You have not added any bots yet.' }));
        else list.appendChild(simpleTable(['Bot', 'Market', 'Risk', 'Status', ''], d.bots.map(function (b) {
            var st = LIB_STATUS[b.status] || [b.status, ''];
            var acts = el('div', { class: 'row' }, [
                b.status === 'live' ? el('button', { class: 'btn', text: 'Edit', onclick: function () { S.editBot = b.id; route(); } }) : null,
                el('button', { class: 'btn', text: 'Delete', onclick: function () {
                    if (!confirm('Delete "' + b.name + '"? It disappears from your site.')) return;
                    api('/api/library', 'POST', { action: 'delete_bot', id: b.id }).then(function (x) { if (x.bots) { toast('Bot deleted.'); route(); } else toast(x.error || 'Could not delete.'); }); } })]);
            return [el('div', {}, [el('b', { text: b.name }), el('div', { class: 'muted small', text: b.description })]), b.market, b.risk_level,
                el('div', {}, [pill(st[0], st[1]), b.status === 'removed' && b.removed_note ? el('div', { class: 'muted small', text: 'Reason: ' + b.removed_note }) : null]), acts];
        })));
        body.appendChild(list);
    }

    function botRequests(body, d) {
        var title = el('input', { type: 'text', name: 'title', maxlength: '120', autocomplete: 'off', placeholder: 'e.g. Even/Odd bot with a stop-loss' });
        var details = el('textarea', { name: 'details', maxlength: '2000', placeholder: 'Which market, which contract type, how it should decide, and how risky you want it.' });
        var ft = box('Short title', title), fd = box('What should the bot do?', details);
        var msg = el('div', { class: 'err' });
        var send = el('button', { class: 'btn primary', text: 'Send request' });
        send.addEventListener('click', function () {
            ft.setError(''); fd.setError(''); msg.textContent = ''; send.disabled = true;
            api('/api/library', 'POST', { action: 'request_bot', title: title.value, details: details.value }).then(function (r) {
                send.disabled = false;
                if (r.requests) { toast('Request sent.'); route(); return; }
                if (r.fields && r.fields.title) ft.setError(r.fields.title); if (r.fields && r.fields.details) fd.setError(r.fields.details);
                msg.textContent = r.fields ? '' : (r.error || 'Could not send the request.');
            });
        });
        body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Request a bot' }),
            el('p', { class: 'muted', text: 'Tell us what you need and we will answer here. You can have up to ' + d.limits.open_requests + ' requests waiting at once.' }),
            ft.wrap, fd.wrap, el('div', { class: 'row', style: 'margin-top:12px' }, [send, msg])]));
        var list = el('div', { class: 'card' }, [el('h2', { text: 'Your requests' })]);
        if (!d.requests.length) list.appendChild(el('p', { class: 'muted', text: 'No requests yet.' }));
        else list.appendChild(simpleTable(['Sent', 'Request', 'Status', ''], d.requests.map(function (r) {
            var st = REQ_STATUS[r.status] || [r.status, ''];
            var last = r.status === 'open'
                ? el('button', { class: 'btn', text: 'Cancel', onclick: function () {
                    if (!confirm('Cancel this request?')) return;
                    api('/api/library', 'POST', { action: 'cancel_request', id: r.id }).then(function (x) { if (x.requests) { toast('Request cancelled.'); route(); } else toast(x.error || 'Could not cancel.'); }); } })
                : (r.admin_note || '');
            return [fmtDate(r.created_at), el('div', {}, [el('b', { text: r.title }), el('div', { class: 'muted small', text: r.details })]), pill(st[0], st[1]), last];
        })));
        body.appendChild(list);
    }

    function strategiesView() {
        var v = el('div');
        v.appendChild(head('Algorithm marketplace', 'Strategies', 'Upload strategy documents that visitors of your site can download.'));
        var body = el('div');
        v.appendChild(body);
        loadLibrary(v, body, function (d) {
            var title = box('Title', el('input', { type: 'text', name: 'title', maxlength: '120', autocomplete: 'off' }));
            var desc = box('Short description (optional)', el('textarea', { name: 'description', maxlength: '2000' }));
            var file = box('Document', el('input', { type: 'file', name: 'file', accept: '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt' }),
                'PDF, Word, Excel, PowerPoint, PNG, JPG or text. Up to ' + d.limits.file_mb + ' MB.');
            var msg = el('div', { class: 'err' });
            var up = el('button', { class: 'btn primary', text: 'Upload' });
            var card = el('div', { class: 'card' }, [el('h2', { text: 'Add a document' }), title.wrap, desc.wrap, file.wrap]);
            if (!d.storage_ready) { up.disabled = true; card.appendChild(el('div', { class: 'notice', text: 'Uploads are not switched on yet. Please contact support.' })); }
            up.addEventListener('click', function () {
                [title, desc, file].forEach(function (x) { x.setError(''); }); msg.textContent = '';
                var f = file.input.files && file.input.files[0];
                if (!f) { file.setError('Choose a file.'); return; }
                if (f.size > d.limits.file_mb * 1048576) { file.setError('That file is too big (limit ' + d.limits.file_mb + ' MB).'); return; }
                up.disabled = true; up.textContent = 'Uploading…';
                readFile(f, true).then(function (b64) {
                    return api('/api/library', 'POST', { action: 'add_strategy', title: title.input.value, description: desc.input.value, file_name: f.name, file_base64: b64 });
                }).then(function (r) {
                    up.disabled = false; up.textContent = 'Upload';
                    if (r.strategies) { toast('Document added.'); route(); return; }
                    var fe = r.fields || {};
                    if (fe.title) title.setError(fe.title); if (fe.file) file.setError(fe.file);
                    msg.textContent = r.fields ? '' : (r.error || 'Could not upload the document.');
                }).catch(function () { up.disabled = false; up.textContent = 'Upload'; msg.textContent = 'Could not read that file.'; });
            });
            card.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [up, msg]));
            body.appendChild(card);

            var list = el('div', { class: 'card' }, [el('h2', { text: 'Your documents' })]);
            if (!d.strategies.length) list.appendChild(el('p', { class: 'muted', text: 'You have not added any documents yet.' }));
            else list.appendChild(simpleTable(['Document', 'File', 'Added', 'Status', ''], d.strategies.map(function (s) {
                var st = LIB_STATUS[s.status] || [s.status, ''];
                return [el('div', {}, [el('b', { text: s.title }), s.description ? el('div', { class: 'muted small', text: s.description }) : null]),
                    el('div', {}, [s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.file_name }) : document.createTextNode(s.file_name), el('div', { class: 'muted small', text: sizeText(s.size_bytes) })]),
                    fmtDate(s.created_at),
                    el('div', {}, [pill(st[0], st[1]), s.status === 'removed' && s.removed_note ? el('div', { class: 'muted small', text: 'Reason: ' + s.removed_note }) : null]),
                    el('button', { class: 'btn', text: 'Delete', onclick: function () {
                        if (!confirm('Delete "' + s.title + '"? The file is deleted and visitors can no longer download it.')) return;
                        api('/api/library', 'POST', { action: 'delete_strategy', id: s.id }).then(function (x) { if (x.strategies) { toast('Document deleted.'); route(); } else toast(x.error || 'Could not delete.'); }); } })];
            })));
            body.appendChild(list);
            body.appendChild(marketStrip());
        });
        return v;
    }

    var EVENT_TEXT = {
        site_created: function (d) { return 'Site created' + (d && d.domain ? ' at ' + d.domain : ''); },
        custom_domain_requested: function (d) { return 'Own domain requested' + (d && d.domain ? ': ' + d.domain : ''); },
        custom_domain_approved: function (d) { return 'Own domain approved' + (d && d.domain ? ': ' + d.domain : ''); },
        status_changed: function (d) { return d && d.status === 'active' ? 'Site set live' : d && d.status === 'suspended' ? 'Site suspended' : 'Site set to pending review'; },
        details_updated: function () { return 'Site details updated'; },
        markup_changed: function (d) { return 'Markup changed' + (d && d.from !== undefined ? ' from ' + d.from + '% to ' + d.to + '%' : ''); },
        markup_confirmed: function () { return 'Markup confirmed on Deriv'; },
        app_id_assigned: function () { return 'Deriv App ID assigned'; },
        app_create_failed: function () { return 'Your Deriv app is not ready yet, we are finishing it'; },
        app_redirect_updated: function () { return 'Deriv app moved to your own domain'; },
        app_id_cleared: function () { return 'Deriv App ID removed'; },
    };
    function deploymentsView() {
        var v = el('div'), site = S.site;
        v.appendChild(head('System infrastructure', 'Deployments', 'The status of your site and what has happened to it.'));
        var waiting = site && (site.status === 'pending' || site.custom_domain_requested) ? 1 : 0;
        v.appendChild(el('div', { class: 'stats' }, [
            el('div', { class: 'stat' }, [el('small', { text: 'Live' }), el('b', { text: site && site.status === 'active' ? '1' : '0' })]),
            el('div', { class: 'stat' }, [el('small', { text: 'Awaiting approval' }), el('b', { text: String(waiting) })]),
            el('div', { class: 'stat' }, [el('small', { text: 'Suspended' }), el('b', { text: site && site.status === 'suspended' ? '1' : '0' })]),
        ]));
        var hist = el('div', { class: 'card' }, [el('h2', { text: 'Site history' })]);
        if (!S.events.length) hist.appendChild(el('p', { class: 'muted', text: site ? 'No history recorded yet.' : 'Create a site to start its history.' }));
        else {
            var ul = el('ul', { class: 'timeline' });
            S.events.forEach(function (e) {
                var f = EVENT_TEXT[e.event]; var detail = e.detail && typeof e.detail === 'object' ? e.detail : {};
                ul.appendChild(el('li', {}, [el('i'), el('div', {}, [el('span', { text: f ? f(detail) : e.event }), el('small', { text: fmtDate(e.created_at) })])]));
            });
            hist.appendChild(ul);
        }
        v.appendChild(hist);
        return v;
    }

    // Each answer: icon, colour class (f1..f6), question, short answer, steps, optional tip. Text only, no HTML.
    var FAQ = [
        { i: '\u{1F680}', c: 'f1', q: 'How do I create a site?', a: 'Your own branded trading site is ready in about two minutes.',
          steps: ['Open Sites and choose Create new site.', 'Pick a free address (live at once) or enter your own domain.', 'Add your brand name, logo and colours.', 'Press Save. A free address goes live immediately.'],
          tip: 'Start on a free address, then connect your own domain whenever you are ready.' },
        { i: '\u{1F310}', c: 'f2', q: 'How do I connect my own domain?', a: 'Use a domain you already own, such as trade.yourbrand.com.',
          steps: ['Open Domains, type your domain and send the request.', 'Add the DNS record shown on screen at your domain provider.', 'We review it and switch it on.', 'Follow the progress on the Deployments page.'],
          tip: 'DNS changes can take a little while to spread. If it is not live after a few hours, message us on WhatsApp.' },
        { i: '\u{1F4B0}', c: 'f3', q: 'How is commission shared?', a: 'Your share is set out in your agreement with EPM.',
          steps: ['Open Commissions to see what you have earned, month by month.', 'Your markup and share depend on your Deriv app and your agreement.'],
          tip: 'Not sure what your share is? Ask us on WhatsApp and we will confirm it.' },
        { i: '\u{1F4C5}', c: 'f4', q: 'When do I get paid?', a: 'Earnings update once a day and become payable after Deriv pays the month.',
          steps: ['Your earnings refresh daily under Commissions.', 'After Deriv’s monthly partner payment is received and confirmed, that month becomes available.', 'Request a withdrawal to M-Pesa or USDT.', 'We review and pay it out.'],
          tip: 'A month is only paid once Deriv has paid it, so payment follows Deriv’s own monthly schedule.' },
        { i: '\u{1F91D}', c: 'f5', q: 'Who supports my clients?', a: 'It depends on whether you use a free address or your own domain.',
          steps: ['Free address: the platform handles your client support.', 'Your own domain: you handle it, using the contacts you set when editing your site (WhatsApp, phone, email, Telegram).'],
          tip: 'Add your support contacts when editing your site so clients can reach you.' },
        { i: '⚠️', c: 'f6', q: 'Is trading risky?', a: 'Yes. Trading on Deriv carries a high risk of loss.',
          steps: ['Commission is not guaranteed and depends on your clients trading.', 'Never promise profits or guaranteed returns to your clients.', 'Encourage clients to trade only with money they can afford to lose.'],
          tip: 'Being honest about risk protects you and your clients.' },
        { i: '\u{1F916}', c: 'f2', q: 'Can I add my own bots and strategies?', a: 'Yes. Your site can have its own trading bots and strategy documents.',
          steps: ['Open Trading bots to upload a bot (XML file). It goes live on your site at once.', 'Open Strategies to upload documents (PDF, Word, Excel, PowerPoint, images or text).', 'Want a bot we have not built yet? Send a request from the Requests page.'],
          tip: 'You can remove or replace your bots and documents at any time.' },
        { i: '\u{1F3A8}', c: 'f1', q: 'Can you design a website for me?', a: 'Yes. We can design a fully custom website for you, from logo and colours to layout and content.',
          steps: ['Message us on WhatsApp and tell us about your business.', 'Share your brand name, colours, logo and any sites you like.', 'We reply with a plan and a quote, then design it with you.'],
          tip: 'Premium, professional design built around your brand.', cta: true },
    ];
    // One answer at a time, in a popup. Closes with the X button, a click outside, or the Escape key.
    function openFaq(q, opener) {
        var old = document.getElementById('faq-modal'); if (old) old.remove();
        var prevOverflow = document.body.style.overflow;
        var done = false, onKey;
        function close() {
            if (done) return; done = true;
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            overlay.classList.add('closing');
            setTimeout(function () { overlay.remove(); if (opener && opener.focus) opener.focus(); }, 200);
        }
        var closeBtn = el('button', { class: 'fm-x', type: 'button', 'aria-label': 'Close', text: '\u2715', onclick: close });
        var body = el('div', { class: 'fm-body' }, [el('p', { class: 'faq-lead', text: q.a })]);
        body.appendChild(el('ol', { class: 'faq-steps' }, q.steps.map(function (t) { return el('li', { text: t }); })));
        if (q.tip) body.appendChild(el('div', { class: 'faq-tip' }, [el('strong', { text: 'Good to know  ' }), el('span', { text: q.tip })]));
        if (q.cta) body.appendChild(el('a', { class: 'btn dc-btn', href: waLink('Hello EPM, I would like you to design a website for me.'), target: '_blank', rel: 'noopener', text: 'Request a design on WhatsApp' }));
        var dialog = el('div', { class: 'fm-card ' + q.c, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fm-title' }, [
            el('div', { class: 'fm-head' }, [el('span', { class: 'fm-ico', text: q.i }), el('h3', { id: 'fm-title', text: q.q }), closeBtn]), body]);
        var overlay = el('div', { class: 'faq-modal', id: 'faq-modal' }, [dialog]);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        onKey = function (e) { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
        closeBtn.focus();
    }
    function supportView() {
        var v = el('div');
        v.appendChild(head('Help', 'Support', 'Chat with us on WhatsApp, or browse answers to common questions.'));
        v.appendChild(el('div', { class: 'card row between' }, [el('div', {}, [el('h2', { text: 'WhatsApp support' }), el('span', { class: 'muted', text: 'Chat with us at ' + WA_SHOW + ' for setup help, billing questions and technical support.' })]),
            el('a', { class: 'btn green', href: waLink('Hello EPM, I need help with my site.'), target: '_blank', rel: 'noopener', text: 'Chat on WhatsApp' })]));
        v.appendChild(el('div', { class: 'design-cta' }, [
            el('div', { class: 'dc-text' }, [el('span', { class: 'dc-kicker', text: 'Custom design' }), el('h2', { text: 'Want a premium website designed for you?' }),
                el('p', { text: 'Tell us about your brand and we will design a professional, one-of-a-kind website for you.' })]),
            el('a', { class: 'btn dc-btn', href: waLink('Hello EPM, I would like you to design a website for me.'), target: '_blank', rel: 'noopener', text: 'Request a design' })]));
        var faq = el('div', { class: 'faq' }, [el('h2', { class: 'faq-title', text: 'Frequently asked questions' }), el('p', { class: 'muted', text: 'Tap a question to see the full answer.' })]);
        FAQ.forEach(function (q) {
            var card = el('button', { class: 'faq-item ' + q.c, type: 'button', 'aria-haspopup': 'dialog' }, [el('span', { class: 'faq-ico', text: q.i }), el('span', { class: 'faq-q', text: q.q }), el('span', { class: 'faq-chev', text: '\u203A' })]);
            card.addEventListener('click', function () { openFaq(q, card); });
            faq.appendChild(card);
        });
        v.appendChild(faq);
        return v;
    }

    function installNow() {
        if (!installEvent) return;
        installEvent.prompt();
        installEvent.userChoice.then(function () { installEvent = null; closeModal(); });
    }
    function closeModal() { var m = document.getElementById('install-modal'); if (m) m.remove(); }
    function maybeShowInstall() {
        if (!installEvent || document.getElementById('install-modal')) return;
        try { var until = Number(localStorage.getItem('epm_install_dismissed') || 0); if (until > Date.now()) return; } catch (e) { /* storage unavailable */ }
        var box = el('div', { class: 'box' }, [el('img', { src: '/app/icon-192.png', alt: '' }), el('h2', { text: 'Install EPM' }),
            el('p', { text: 'Add the dashboard to your device for one-tap access and an app-like experience.' }),
            el('button', { class: 'btn primary', text: 'Install app', onclick: installNow }),
            el('button', { class: 'btn ghost', text: 'Not now', onclick: function () { try { localStorage.setItem('epm_install_dismissed', String(Date.now() + 7 * 864e5)); } catch (e) { /* ignore */ } closeModal(); } })]);
        document.body.appendChild(el('div', { class: 'modal', id: 'install-modal' }, [box]));
    }

    function settingsView() {
        var v = el('div'), o = S.owner;
        v.appendChild(head('Account', 'Settings'));
        v.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Profile' }),
            el('table', { class: 'kv' }, [el('tr', {}, [el('th', { text: 'Full name' }), el('td', { text: o.name })]), el('tr', {}, [el('th', { text: 'Email address' }), el('td', { text: o.email })])])]));
        var installBtn = el('button', { class: 'btn primary', text: 'Install app', onclick: installNow });
        installBtn.disabled = !installEvent;
        v.appendChild(el('div', { class: 'card row between' }, [el('div', {}, [el('h2', { text: 'Install the EPM app' }),
            el('span', { class: 'muted', text: installEvent ? 'Add EPM to this device for one-tap access and a full-screen experience.' : 'Use your browser\u2019s menu and choose "Install" or "Add to home screen" to add EPM to this device.' })]), installBtn]));

        var hasPw = o.has_password !== false;
        var pw = pwField('password', 'Your password'), conf = field('confirm', 'Type DELETE to confirm', 'text'), msg = el('div', { class: 'err' });
        var del = el('button', { class: 'btn danger', text: 'Delete my account', onclick: function () {
            msg.textContent = ''; del.disabled = true;
            api('/api/auth?action=delete_account', 'POST', { password: hasPw ? pw.input.value : undefined, confirm: conf.input.value }).then(function (r) {
                del.disabled = false;
                if (r.ok) { S.owner = null; S.site = null; S.comm = null; S.lib = null; authView(false); toast('Your account has been deleted.'); } else msg.textContent = r.error || 'Could not delete the account.'; }); } });
        v.appendChild(el('div', { class: 'card danger-zone' }, [el('h2', { text: 'Danger zone' }),
            el('p', { class: 'muted', text: 'Deleting your account is permanent. Your site goes offline and your settings are removed.' + (hasPw ? '' : ' You signed in with Google, so there is no password to enter.') }), hasPw ? pw.wrap : null, conf.wrap, msg, del]));
        return v;
    }

    /* ---------- boot ---------- */
    // Put a /api/bootstrap answer into memory. Returns true when something actually changed.
    function applyData(r) {
        var changed = false, st = r.state || {};
        function set(key, val) { if (!same(S[key], val)) { S[key] = val; changed = true; } }
        set('site', st.site || null); set('events', st.events || []);
        if (st.dns) S.dns = st.dns;
        if (typeof st.free_root === 'string') S.freeRoot = st.free_root;
        if (r.commissions) set('comm', strip(r.commissions));
        if (r.library) set('lib', strip(r.library));
        return changed;
    }
    // Loads everything in one request. Falls back to the single-purpose call if the new one is not there yet.
    function loadSite() {
        return api('/api/bootstrap').then(function (r) {
            if (r.__status === 401) return;
            if (r.__status === 200 && r.state) { applyData(r); return; }
            return api('/api/my-site').then(function (s) {
                if (s.__status === 401) return;
                S.site = s.site || null; S.events = s.events || []; if (s.dns) S.dns = s.dns; if (typeof s.free_root === 'string') S.freeRoot = s.free_root;
            });
        });
    }
    // Has the person typed or chosen anything on this page? Then a quiet refresh must not redraw it under them.
    var touched = false;
    function formDirty() { return touched; }
    var lastSync = Date.now(), syncing = false, updateReady = false;
    // Refresh in the background. The page you are on is only redrawn if something changed and you are not typing.
    function revalidate(force) {
        if (!S.owner || S.owner.role === 'admin' || syncing || (!force && Date.now() - lastSync < 8000)) return;
        syncing = true; lastSync = Date.now();
        api('/api/bootstrap').then(function (r) {
            syncing = false;
            if (r.__status !== 200 || !r.state) return;
            if (applyData(r) && viewEl && !formDirty()) route(true);
        });
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') revalidate(true); });

    // One request brings everything. If it is not available (for example while an update is still rolling out), the older two-step start is used.
    function boot() {
        api('/api/bootstrap').then(function (r) {
            if (r.__status === 200 && 'owner' in r) return start(r, true);
            api('/api/auth?action=me').then(function (m) { start(m, false); });
        });
    }
    function start(r, haveData) {
        S.google = !!r.google;
        if (!r.owner) {
            S.owner = null; S.comm = null; S.lib = null;
            var code = new URLSearchParams(location.search).get('google');
            if (code) history.replaceState(null, '', location.pathname + location.hash);
            return authView(code !== 'disabled' && code !== 'admin', code ? (GOOGLE_MESSAGES[code] || GOOGLE_MESSAGES.error) : '');
        }
        S.owner = r.owner;
        if (r.owner.role === 'admin') {
            clear(root); root.appendChild(el('div', { class: 'auth' }, [el('div', { class: 'card' }, [el('h2', { text: 'Admin account' }), el('p', { class: 'muted', text: 'Use the admin panel to manage sites and accounts.' }), el('a', { class: 'btn primary', href: '/admin', text: 'Go to the admin panel' })])]));
            return;
        }
        var ready = function () { lastSync = Date.now(); mountShell(); route(); setTimeout(maybeShowInstall, 1500); };
        if (haveData && r.state) { applyData(r); ready(); } else loadSite().then(ready);
    }

    window.addEventListener('hashchange', function () { route(); });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; if (S.owner) { maybeShowInstall(); if ((location.hash || '').indexOf('settings') > -1) route(); } });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () { /* installability is optional */ });
        navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'epm-updated') updateReady = true; });
    }
    boot();
})();
