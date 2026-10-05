const { getDb } = require('./_lib/db');
const A = require('./_lib/auth');

const TERMS_VERSION = '2026-10-04';
const send = (res, code, body) => res.status(code).json(body);
const noStore = res => res.setHeader('Cache-Control', 'no-store');

// Operator accounts. Admin accounts can NOT be created here -- only with
// scripts/create-admin.js -- so the public sign-up can never mint an admin.
//
//   GET  /api/auth?action=me
//   POST /api/auth?action=register   { email, name, password, registration_code? }
//   POST /api/auth?action=login      { email, password }
//   POST /api/auth?action=logout
//   POST /api/auth?action=delete_account   { password, confirm: 'DELETE' }
module.exports = async function handler(req, res) {
    noStore(res);
    if (!A.onPlatformHost(req, 'open')) return send(res, 404, { error: 'Not found' });

    const action = String(req.query.action || '');
    const sql = getDb();

    try {
        if (req.method === 'GET' && action === 'me') {
            const me = await A.getSession(sql, req);
            return send(res, 200, { owner: me });
        }

        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        if (!A.sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
        const body = A.readBody(req);
        const ip = A.clientIp(req);

        if (action === 'register') {
            if ((await A.hit(sql, `register:ip:${ip}`, 3600)) > 5) {
                return send(res, 429, { error: 'Too many sign-ups from this network. Try again later.' });
            }
            const code = process.env.REGISTRATION_CODE;
            if (code && String(body.registration_code || '') !== code) {
                return send(res, 403, { error: 'A valid registration code is required.' });
            }
            if (body.accept_terms !== true) return send(res, 400, { error: 'Please accept the Terms of Service and Privacy Policy to continue.' });
            const email = A.validateEmail(body.email);
            const name = typeof body.name === 'string' ? body.name.trim().replace(/[<>]/g, '') : '';
            if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
            if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'Enter your name (2-80 characters).' });
            const pwErr = A.validatePassword(body.password, email);
            if (pwErr) return send(res, 400, { error: pwErr });

            const hash = await A.hashPassword(body.password);
            let owner;
            try {
                const rows = await sql`
                    INSERT INTO owners (email, name, password_hash, role)
                    VALUES (${email}, ${name}, ${hash}, 'operator')
                    RETURNING id, email, name, role
                `;
                owner = rows[0];
            } catch (err) {
                if (err && err.code === '23505') return send(res, 409, { error: 'An account with this email already exists.' });
                throw err;
            }
            await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${owner.id}, 'terms_accepted', ${email}, ${JSON.stringify({ version: TERMS_VERSION })}::jsonb)`;
            const token = await A.createSession(sql, owner.id);
            res.setHeader('Set-Cookie', A.sessionCookie(req, token, A.SESSION_DAYS * 86400));
            return send(res, 201, { owner });
        }

        if (action === 'login') {
            const email = A.validateEmail(body.email);
            const password = typeof body.password === 'string' ? body.password.slice(0, A.MAX_PASSWORD) : '';
            if (!email || !password) return send(res, 400, { error: 'Enter your email and password.' });

            const tooMany =
                (await A.hit(sql, `login:ip:${ip}`, 900)) > 20 ||
                (await A.hit(sql, `login:email:${email}`, 900)) > 8;
            if (tooMany) return send(res, 429, { error: 'Too many attempts. Please wait 15 minutes and try again.' });

            const rows = await sql`SELECT id, email, name, role, password_hash, disabled FROM owners WHERE email = ${email} LIMIT 1`;
            const row = rows[0];
            // Same work whether or not the email exists, so response time doesn't reveal accounts.
            const ok = row ? await A.verifyPassword(password, row.password_hash) : await A.dummyVerify(password);
            if (!row || !ok || row.disabled) return send(res, 401, { error: 'Incorrect email or password.' });

            await A.clearHits(sql, `login:email:${email}`);
            const token = await A.createSession(sql, row.id);
            res.setHeader('Set-Cookie', A.sessionCookie(req, token, A.SESSION_DAYS * 86400));
            return send(res, 200, { owner: { id: row.id, email: row.email, name: row.name, role: row.role } });
        }

        // Permanently deletes the signed-in operator's account AND their site. Needs the password and the word DELETE.
        if (action === 'delete_account') {
            const me = await A.getSession(sql, req);
            if (!me) return send(res, 401, { error: 'Please sign in.' });
            if (me.role !== 'operator') return send(res, 403, { error: 'Admin accounts cannot be deleted here.' });
            if ((await A.hit(sql, `delete:owner:${me.id}`, 3600)) > 5) return send(res, 429, { error: 'Too many attempts. Please try again later.' });
            if (String(body.confirm || '').trim() !== 'DELETE') return send(res, 400, { error: 'Type DELETE to confirm.' });
            const row = (await sql`SELECT password_hash FROM owners WHERE id = ${me.id} LIMIT 1`)[0];
            const okPw = row ? await A.verifyPassword(typeof body.password === 'string' ? body.password.slice(0, A.MAX_PASSWORD) : '', row.password_hash) : false;
            if (!okPw) return send(res, 401, { error: 'Incorrect password.' });
            const gone = await sql`DELETE FROM sites WHERE owner_id = ${me.id} RETURNING domain`;
            await sql`DELETE FROM owners WHERE id = ${me.id}`; // sessions go with it
            await sql`INSERT INTO audit_log (owner_id, action, target, detail) VALUES (${me.id}, 'account_deleted_by_owner', ${me.email}, ${JSON.stringify({ sites_removed: gone.map(g => g.domain) })}::jsonb)`;
            res.setHeader('Set-Cookie', A.clearCookie(req));
            return send(res, 200, { ok: true });
        }

        if (action === 'logout') {
            await A.destroySession(sql, req);
            res.setHeader('Set-Cookie', A.clearCookie(req));
            return send(res, 200, { ok: true });
        }

        return send(res, 400, { error: 'Unknown action' });
    } catch (err) {
        console.error('auth error:', err);
        return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
};
