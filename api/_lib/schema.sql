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
    platform_share NUMERIC(5,2) NOT NULL,          -- percent the platform keeps
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

-- ===== Step 2 (wizard): per-site Deriv markup and App ID =====
-- markup_percent: the markup % the operator chose for this site (0-3). The admin sets the same markup on that site's app in Deriv.
-- app_id: the Deriv app the admin created for this site. NULL = still awaiting assignment.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS markup_percent NUMERIC(4,2) NOT NULL DEFAULT 1.00;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS app_id TEXT;

-- ===== Pre-made Deriv apps, handed out automatically =====
-- You create apps in Deriv by hand (one per site, each with its markup) and paste the IDs into the admin panel.
-- When a site is created, it gets the next unused app with exactly its markup. Each app is used by ONE site only,
-- so Deriv's markup report stays per site. An app is "free" while assigned_at IS NULL; once used it is never reused,
-- even if the site is deleted (its history stays attached to that app).
CREATE TABLE IF NOT EXISTS app_pool (
    id             SERIAL PRIMARY KEY,
    app_id         TEXT NOT NULL UNIQUE,
    markup_percent NUMERIC(4,2) NOT NULL,
    site_id        INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    assigned_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_pool_free_idx ON app_pool (markup_percent, id) WHERE assigned_at IS NULL;

-- ===== Where a site's App ID came from =====
-- 'api' = created for the site through Deriv's API (its markup/redirect are then kept in step automatically);
-- 'creating' = being created right now; NULL = pool or hand-assigned.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS app_source TEXT;

-- ===== Step 3: commissions =====
-- One row per Deriv app per UTC day, filled from Deriv's markup statistics (api/_lib/commissions.js).
-- markup_usd and platform_share are for the admin only: operators are only ever shown owner_usd.
CREATE TABLE IF NOT EXISTS commission_daily (
    id             SERIAL PRIMARY KEY,
    app_id         TEXT NOT NULL,
    day            DATE NOT NULL,
    site_id        INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    owner_id       INTEGER REFERENCES owners(id) ON DELETE SET NULL,
    markup_usd     NUMERIC(14,4) NOT NULL,         -- what Deriv attributes to the app that day
    volume_usd     NUMERIC(16,2) NOT NULL DEFAULT 0,
    contracts      INTEGER NOT NULL DEFAULT 0,
    clients        INTEGER NOT NULL DEFAULT 0,
    platform_share NUMERIC(5,2) NOT NULL,          -- percent the platform kept, as agreed on that day
    owner_usd      NUMERIC(14,4) NOT NULL,         -- the operator's part
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, day)
);
CREATE INDEX IF NOT EXISTS commission_daily_owner_idx ON commission_daily (owner_id, day);

-- A month is "confirmed" once Deriv has paid it to you. Only confirmed months can be withdrawn.
CREATE TABLE IF NOT EXISTS commission_months (
    month        TEXT PRIMARY KEY,                 -- 'YYYY-MM'
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by INTEGER,
    note         TEXT
);

-- Withdrawal requests. You pay them by hand (M-Pesa or USDT), then mark them paid with the reference.
CREATE TABLE IF NOT EXISTS payout_requests (
    id          SERIAL PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    amount_usd  NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
    method      TEXT NOT NULL CHECK (method IN ('mpesa', 'usdt')),
    network     TEXT,                              -- USDT only: TRC20, ERC20 or BEP20
    destination TEXT NOT NULL,                     -- phone as 2547xxxxxxxx, or a wallet address
    status      TEXT NOT NULL DEFAULT 'requested', -- requested | paid | rejected | cancelled
    reference   TEXT,                              -- M-Pesa code or transaction hash, set when paid
    note        TEXT,                              -- reason shown to the operator when rejected
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payout_requests_owner_idx ON payout_requests (owner_id, id DESC);
-- One open request per operator at a time: also stops a double click from asking twice.
CREATE UNIQUE INDEX IF NOT EXISTS payout_one_open_idx ON payout_requests (owner_id) WHERE status = 'requested';
