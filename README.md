# EPM white-label platform prototype

An isolated React and TypeScript prototype using Rsbuild and React Router, based
on the stack in the existing `epm-botbuilder` repository. It is intentionally
kept separate so its page and assets can be adapted into the main repository
after the flow is approved.

## Run locally

Requires Node.js 18.18 or newer.

```sh
npm install
npm run dev
```

The preview runs at `http://localhost:4003`. Run `npm run type-check` and
`npm run build` before integrating it into another project.

## Included in the prototype

- EPM landing, features, how-it-works, about, and contact pages.
- Demo signup/sign-in and a site-owner workspace. The demo profile and site
  configuration are stored in the browser only.
- A four-step setup for one branded site per demo profile: site name, tagline,
  brand color, and an optional domain.
- A public-facing branded site preview at `/p/<site-name>`. The preview does
  not expose the site owner's workspace, the operator's partner account, or
  platform-admin controls.
- A site-owner commission view (illustrative only, no real figures).

## Business flow to implement in the backend

All commission generated for eligible activity is treated as a pool that is
split between EPM and the site owner under their agreement. Eligible activity accrues during the month and is attributed to the platform
operator's Deriv partner account. Deriv pays the operator monthly; after that
payment is reconciled, the operator settles the site owner's agreed share.
Rates and eligibility rules must match the actual partner and site-owner
agreements.

This repository is a UI prototype, not a trading or payout system. It has no
real Deriv connection, live trader authentication, real-time prices, trade
attribution, monthly reconciliation, settlement, DNS verification, or live
deployment. Do not collect real passwords or payment details with this demo.
There is no platform-admin UI in the prototype; customer-facing routes should
never be treated as an authorization boundary for future administrative tools.

Before production, implement and test:

- Server-side authentication, tenant ownership checks, and role-based access.
- Separate tenant data for each site; never rely on hidden frontend routes for
  authorization or tenant isolation.
- Authorized Deriv integrations, trade attribution, idempotent monthly
  reconciliation, audit history, and owner settlement records.
- Verified payout methods, retryable payout processing, clear statements, and
  operational support.
- Domain verification and isolated site deployment.
- Reviewed privacy, service, trading-risk, and commission disclosures.

Any figures in the UI are illustrative and are not a promise of Deriv's
terms, earnings, or payout timing.

## Deriv apps for each site (automatic)

When an operator creates a site, the backend registers a Deriv app for it through
Deriv's API (`api/_lib/deriv-apps.js`) with that site's markup and redirect, and
stores the App ID on the site. Markup changes are pushed to the same app. If Deriv
is unreachable the site falls back to the pre-made App ID pool, and otherwise
waits as "awaiting App ID" until an admin clicks **Create on Deriv**.

Set these in Vercel (Settings, Environment Variables), then redeploy:

| Variable | Needed | What it is |
| --- | --- | --- |
| `DERIV_ADMIN_TOKEN` | yes | A Deriv API token with the **Admin** scope. Keep it secret. |
| `DERIV_REDIRECT_URI` | yes | The login return address of your main site (free sites share it). |
| `DERIV_REDIRECT_PATH` | no | Path added to a custom domain, default `/`. |
| `DERIV_APP_SCOPES` | no | Default `read,trade,trading_information`. |
| `DERIV_WS_URL` / `DERIV_WS_APP_ID` | no | Override the Deriv socket address / the id used to open it. |

The admin panel has a **Deriv connection** card with a Test connection button.
Run `api/_lib/schema.sql` once in Neon (it is safe to run again) before deploying:
it adds `sites.app_source`.
