/* Site owner dashboard. Everything from the server is rendered with textContent (never innerHTML). */
(function () {
    'use strict';

    var MARKETING = ''; // Terms and Privacy live on this same site
    var WA = '254115533208', WA_SHOW = '+254 115 533 208';
    var FONTS = ['', 'Inter', 'Roboto', 'Poppins', 'DM Sans', 'Lato', 'Nunito', 'Open Sans', 'Montserrat', 'Raleway', 'Source Sans 3'];
    var root = document.getElementById('app');
    var S = { owner: null, site: null, google: false, freeRoot: '', dns: { cname: 'cname.vercel-dns-0.com', a: '76.76.21.21' }, events: [] };
    var installEvent = null, viewEl = null, sideEl = null, scrimEl = null, whoEl = null;

    /* ---------- helpers ---------- */
    function api(path, method, body) {
        return fetch(path, {
            method: method || 'GET', credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); })
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
        ['commissions', 'Commissions', 'cash', true], ['bots', 'Trading bots', 'bot', true], ['strategies', 'Strategies', 'file', true],
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
        whoEl = el('div', { class: 'who' }, ['Signed in ', el('b', { text: S.owner.name })]);
        var logout = el('button', { class: 'btn', text: 'Log out', onclick: function () { api('/api/auth?action=logout', 'POST').then(function () { S.owner = null; S.site = null; authView(false); }); } });
        viewEl = el('main', { id: 'view' });
        root.appendChild(el('div', { class: 'shell' }, [sideEl, el('div', { class: 'main' }, [el('div', { class: 'top' }, [menu, whoEl, logout]), viewEl])]));
        root.appendChild(scrimEl);
        nav.addEventListener('click', closeMenu);
    }
    function closeMenu() { if (sideEl) sideEl.classList.remove('open'); if (scrimEl) scrimEl.classList.add('hidden'); }

    function route() {
        if (!S.owner || !viewEl) return;
        var path = (location.hash || '#/sites').replace(/^#\//, '');
        var base = path.split('/')[0] || 'sites';
        var views = {
            'sites': sitesView, 'sites/new': function () { return siteForm(true); }, 'sites/edit': function () { return siteForm(false); },
            'domains': domainsView, 'deployments': deploymentsView, 'support': supportView, 'settings': settingsView,
            'commissions': function () { return soon('Revenue streams', 'Commissions', 'Your earnings, history and withdrawals will appear here once commission tracking launches. Your agreed share is set out in your agreement with EPM.'); },
            'bots': function () { return soon('Algorithm marketplace', 'Trading bots', 'Browse the central bot library and upload your own bots for your site. Coming soon.'); },
            'strategies': function () { return soon('Algorithm marketplace', 'Strategies', 'Upload strategy documents for your clients to download. Coming soon.'); },
        };
        var render = views[path] || views[base] || sitesView;
        Array.prototype.forEach.call(sideEl.querySelectorAll('a'), function (a) { a.classList.toggle('on', a.getAttribute('data-route') === base); });
        clear(viewEl); viewEl.appendChild(render()); window.scrollTo(0, 0);
        var item = NAV.filter(function (n) { return n[0] === base; })[0];
        document.title = (item ? item[1] : 'Dashboard') + ' | EPM';
    }
    function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

    /* ---------- pages ---------- */
    function soon(kicker, title, text) {
        return el('div', {}, [head(kicker, title), el('div', { class: 'card empty' }, [el('div', { class: 'bubble' }, [svg(ICON.menu)]), el('h2', { text: 'Coming soon' }), el('p', { text: text })])]);
    }
    function supportBanner() {
        return el('div', { class: 'banner' }, [
            el('div', {}, [el('b', { text: 'Facing a challenge? Reach out to us' }), el('span', { text: 'We are here to help you get your site up and running.' })]),
            el('div', { class: 'row' }, [
                el('a', { class: 'btn green', href: waLink('Hello EPM, I need help with my site.'), target: '_blank', rel: 'noopener', text: 'Chat on WhatsApp' }),
                el('a', { class: 'btn', href: waLink('Hello EPM, please call me about my site.'), target: '_blank', rel: 'noopener', text: 'Request a call' })]),
        ]);
    }

    function sitesView() {
        var v = el('div'), site = S.site;
        v.appendChild(el('div', { class: 'row between' }, [head('Welcome ' + S.owner.name.split(' ')[0], 'Your sites'),
            site ? null : el('a', { class: 'btn primary', href: '#/sites/new', text: 'Create new site' })]));
        v.appendChild(supportBanner());
        if (!site) {
            v.appendChild(el('div', { class: 'card empty' }, [el('div', { class: 'bubble' }, [svg(ICON.store)]),
                el('h2', {}, ['No sites yet.', el('span', { text: 'Let\u2019s build your first one!' })]),
                el('p', { text: 'Choose a free address that goes live instantly, or connect your own domain. Add your branding and you are ready.' }),
                el('a', { class: 'btn primary', href: '#/sites/new', text: '+ Create your first site' })]));
            return v;
        }
        var card = el('div', { class: 'card' }, [
            el('div', { class: 'row between' }, [el('h2', { text: site.name }), el('div', { class: 'row' }, [pill(site.status, site.status), pill(site.plan === 'free' ? 'Free address' : 'Own domain')])]),
            el('p', { class: 'muted', style: 'margin:2px 0 10px' }, [site.domain]),
        ]);
        card.appendChild(el('p', { style: 'margin:0 0 12px' }, ['Markup ', el('b', { text: Number(site.markup_percent).toFixed(2) + '%' }), ' \u00b7 App ID ', site.app_id ? el('b', { text: site.app_id }) : pill('Awaiting assignment', 'pending')]));
        if (!site.app_id) card.appendChild(el('div', { class: 'notice', text: 'We are setting up your own Deriv app for this site. Your earnings are tracked separately once your App ID is assigned, and we will show it here.' }));
        if (site.status === 'pending') card.appendChild(el('div', { class: 'notice', text: 'Waiting for approval. Your site goes live once your domain is set up and reviewed.' }));
        if (site.status === 'suspended') card.appendChild(el('div', { class: 'notice bad', text: 'This site is suspended. Please contact support.' }));
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
            var mkE = markupField(site.markup_percent, site.markup_locked, site.app_id ? 'If you change it, our team updates it on your Deriv app.' : 'Your site gets its own Deriv app for the markup you pick.'); fields.markup_percent = mkE;
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
        var cur = S.domainTab || 'yours';
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
            function search() {
                var name = String(q.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
                var label = name.split('.')[0];
                clear(out);
                if (!label) { out.textContent = 'Type a name to search.'; return; }
                if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) { out.textContent = 'Use only letters, numbers and hyphens, with no spaces, and do not start or end with a hyphen.'; return; }
                out.appendChild(el('p', {}, ['Searching for ', el('strong', { text: label }), ' is not switched on yet.']));
                out.appendChild(el('p', { text: 'Availability and prices in KES will appear here once a domain registrar and M-Pesa payments are connected. Nothing is charged today.' }));
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
            body.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Payment history' }), el('p', { class: 'muted', text: 'No domain payments yet. Purchases will be listed here with the date, amount and status.' })]));
        }
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

    var FAQ = [
        ['How do I create a site?', 'Open Sites, choose Create new site, pick a free address or your own domain, and add your branding. A free address goes live immediately.'],
        ['How do I connect my own domain?', 'Open Domains, enter your domain and send the request, then add the DNS record shown. We review and activate it, and the Deployments page shows the progress.'],
        ['How is commission shared?', 'Your share of commission is set out in your agreement with EPM. If you are unsure of it, ask us on WhatsApp.'],
        ['When do I get paid?', 'Commission accrues through the month. After Deriv\u2019s monthly partner payment has been received and reconciled, your share is paid out. Earnings and withdrawals will appear under Commissions once they launch.'],
        ['Who supports my clients?', 'On a free address, the platform handles client support. On your own domain, you handle it with the contacts you set when editing your site.'],
        ['Is trading risky?', 'Yes. Trading on Deriv carries a high risk of loss and commission is not guaranteed. Never promise profits to your clients.'],
    ];
    function supportView() {
        var v = el('div');
        v.appendChild(head('Help', 'Support', 'Chat with us on WhatsApp, or browse answers to common questions.'));
        v.appendChild(el('div', { class: 'card row between' }, [el('div', {}, [el('h2', { text: 'WhatsApp support' }), el('span', { class: 'muted', text: 'Chat with us at ' + WA_SHOW + ' for setup help, billing questions and technical support.' })]),
            el('a', { class: 'btn green', href: waLink('Hello EPM, I need help with my site.'), target: '_blank', rel: 'noopener', text: 'Chat on WhatsApp' })]));
        var faq = el('div', { class: 'card' }, [el('h2', { text: 'Frequently asked questions' })]);
        FAQ.forEach(function (q) { faq.appendChild(el('details', {}, [el('summary', { text: q[0] }), el('p', { text: q[1] })])); });
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
            el('table', {}, [el('tr', {}, [el('th', { text: 'Full name' }), el('td', { text: o.name })]), el('tr', {}, [el('th', { text: 'Email address' }), el('td', { text: o.email })])])]));
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
                if (r.ok) { S.owner = null; S.site = null; authView(false); toast('Your account has been deleted.'); } else msg.textContent = r.error || 'Could not delete the account.'; }); } });
        v.appendChild(el('div', { class: 'card danger-zone' }, [el('h2', { text: 'Danger zone' }),
            el('p', { class: 'muted', text: 'Deleting your account is permanent. Your site goes offline and your settings are removed.' + (hasPw ? '' : ' You signed in with Google, so there is no password to enter.') }), hasPw ? pw.wrap : null, conf.wrap, msg, del]));
        return v;
    }

    /* ---------- boot ---------- */
    function loadSite() {
        return api('/api/my-site').then(function (s) {
            if (s.__status === 401) return;
            S.site = s.site || null; S.events = s.events || []; if (s.dns) S.dns = s.dns; if (typeof s.free_root === 'string') S.freeRoot = s.free_root;
        });
    }
    function boot() {
        api('/api/auth?action=me').then(function (r) {
            S.google = !!r.google;
            if (!r.owner) {
                S.owner = null;
                var code = new URLSearchParams(location.search).get('google');
                if (code) history.replaceState(null, '', location.pathname + location.hash);
                return authView(code !== 'disabled' && code !== 'admin', code ? (GOOGLE_MESSAGES[code] || GOOGLE_MESSAGES.error) : '');
            }
            S.owner = r.owner;
            if (r.owner.role === 'admin') {
                clear(root); root.appendChild(el('div', { class: 'auth' }, [el('div', { class: 'card' }, [el('h2', { text: 'Admin account' }), el('p', { class: 'muted', text: 'Use the admin panel to manage sites and accounts.' }), el('a', { class: 'btn primary', href: '/admin', text: 'Go to the admin panel' })])]));
                return;
            }
            loadSite().then(function () { mountShell(); route(); setTimeout(maybeShowInstall, 1500); });
        });
    }

    window.addEventListener('hashchange', route);
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; if (S.owner) { maybeShowInstall(); if ((location.hash || '').indexOf('settings') > -1) route(); } });
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () { /* installability is optional */ }); }
    boot();
})();
