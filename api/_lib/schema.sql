-- Per-site settings. One row per operator domain.
-- Run once against your Neon database (SQL editor) before deploying the
-- site-settings endpoint. Safe to re-run.
CREATE TABLE IF NOT EXISTS sites (
    id            SERIAL PRIMARY KEY,
    domain        TEXT NOT NULL UNIQUE,          -- lowercase host, no port, e.g. trade.alice.com
    name          TEXT NOT NULL,
    primary_color TEXT,                          -- #rrggbb
    font          TEXT,                          -- one of the supported fonts
    logo_url      TEXT,                          -- https:// URL
    whatsapp      TEXT,                          -- digits only, with country code
    phone         TEXT,
    support_email TEXT,
    telegram      TEXT,                          -- username, no @
    status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sites_domain_idx ON sites (domain);

-- ===== Step 2: accounts, plans, sessions =====
CREATE TABLE IF NOT EXISTS owners (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,            -- lowercase
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'operator', -- 'operator' | 'admin' (admins are created only by scripts/create-admin.js)
    disabled      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,                   -- SHA-256 of the cookie token
    owner_id   INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions (owner_id);

CREATE TABLE IF NOT EXISTS auth_attempts (         -- rate limiting counters
    key          TEXT PRIMARY KEY,
    count        INTEGER NOT NULL,
    window_start TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         SERIAL PRIMARY KEY,
    owner_id   INTEGER,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sites ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'custom';        -- 'free' (your subdomain) | 'custom' (their own domain)
ALTER TABLE sites ADD COLUMN IF NOT EXISTS about TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS vision TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS mission TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS custom_domain_requested TEXT;               -- upgrade request waiting for approval
ALTER TABLE sites ADD COLUMN IF NOT EXISTS commission_rate_override NUMERIC(5,2);      -- optional per-operator deal (percent YOU keep)
-- One site per operator account.
CREATE UNIQUE INDEX IF NOT EXISTS sites_owner_unique ON sites (owner_id) WHERE owner_id IS NOT NULL;

-- Effective-dated record of the % YOU keep, so an upgrade only changes the rate going forward.
CREATE TABLE IF NOT EXISTS site_rate_history (
    id             SERIAL PRIMARY KEY,
    site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    plan           TEXT NOT NULL,
    platform_share NUMERIC(5,2) NOT NULL,          -- e.g. 25.00 or 15.00
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_rate_history_site_idx ON site_rate_history (site_id, effective_from);

-- ===== Step 3: site history (shown on the operator's Deployments page) =====
CREATE TABLE IF NOT EXISTS site_events (
    id         SERIAL PRIMARY KEY,
    site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    event      TEXT NOT NULL,
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_events_site_idx ON site_events (site_id, id DESC);
