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

## Deriv apps for each site (App ID pool)

Every site gets its own Deriv app, so Deriv's markup report stays per site. Deriv's
current API (api.derivws.com) has no documented way to create or change apps, so
apps are made by hand in the Deriv dashboard and handed out automatically:

1. In the Deriv dashboard, make several apps for each markup group you offer
   (1, 1.5, 2, 2.5 and 3 percent). Use your main site's Authorisation URL as the
   redirect URL.
2. In the admin panel, open **App IDs**, pick the group, paste the App IDs and
   click Add to pool.
3. When an operator creates a site, it takes the next free app with exactly its
   markup (`api/_lib/app-pool.js`, one SQL statement, so two sites never share an
   app). That markup is then fixed by the app, so the operator cannot change it
   afterwards.
4. If a group is empty the site waits as "awaiting App ID" and gets one as soon as
   you add apps. The admin panel shows an **Add Deriv apps** warning when a group
   is empty with sites waiting, or down to two free apps.

Run `api/_lib/schema.sql` once in Neon (it is safe to run again) after each update.

### Optional: automatic app creation (off by default)

`api/_lib/deriv-apps.js` can register and update apps through Deriv's older
WebSocket API. Deriv's current docs do not describe this, so it is untested
against a live account and stays off unless you set `DERIV_AUTO_CREATE=1`.

| Variable | What it is |
| --- | --- |
| `DERIV_AUTO_CREATE` | `1` switches it on. Anything else leaves it off. |
| `DERIV_ADMIN_TOKEN` | A Deriv API token with the Admin scope. Keep it secret. |
| `DERIV_REDIRECT_URI` | The login return address of your main site. |
| `DERIV_REDIRECT_PATH` | Path added to a custom domain, default `/`. |
| `DERIV_APP_SCOPES` | Default `read,trade,trading_information`. |
| `DERIV_WS_URL` / `DERIV_WS_APP_ID` | Override the socket address / the id used to open it. |

## Step 3: Commissions and withdrawals

Operators see their earnings per day and per month, and can request a withdrawal. Deriv pays monthly; a month only counts as withdrawable after an admin presses **Confirm Deriv paid** for it.

**Setup**
1. Run `api/_lib/schema.sql` in Neon (adds `commission_daily`, `commission_months`, `payout_requests`). Safe to run again.
2. Add these in Vercel, then redeploy:
   - `DERIV_STATS_TOKEN`: Deriv token with the `application_read` scope (paste it in Vercel only).
   - `DERIV_STATS_APP_ID`: optional, sent as the `Deriv-App-ID` header.
   - `CRON_SECRET`: any long random string. The daily sync (`/api/cron-commissions`, 03:00 UTC, see `vercel.json`) refuses to run without it.
   - `WITHDRAWAL_MIN_USD`: optional, default 10.
   - `DERIV_API_BASE`: optional, default `https://api.derivws.com`.
3. Admin panel > Commissions: "Sync from Deriv" pulls up to 10 days by hand.

**Rules**
- Earnings come from Deriv's markup report split per app, so each site's income is its own app's markup.
- Operators never see markup, volume or the platform share.
- Confirmed months are frozen. One open withdrawal per operator. Balance is checked in the same SQL statement that creates the request.
- Payouts are manual: the admin sends the money, then presses **Mark paid** with a reference.
- Accounts with money owed or a pending withdrawal cannot be deleted.

## Step 4: Trading bots, strategies and bot requests

Your own central bot library stays in the trading site (`free_bots`). This step adds what an operator puts on **their own site**.

**Setup**
1. Run `api/_lib/schema.sql` in Neon (adds `site_bots`, `site_strategies`, `site_bot_requests`). Safe to run again.
2. For document uploads: in Vercel, open the project, go to **Storage**, create a **Blob** store and connect it to `appbuilder`. Vercel adds `BLOB_READ_WRITE_TOKEN` by itself. Redeploy. Without it the Strategies page says uploads are off; bots and requests still work.

**Rules**
- Operator bots go live at once. The admin panel (Operator bots and documents) lists everything; **Remove** needs a reason, which the operator sees. A removed bot can be put back.
- Removing or deleting a document deletes the stored file, so its old link stops working. Deleting a site or account deletes its files too.
- Bot files must be Deriv Bot `.xml` (no DOCTYPE/ENTITY/script). Documents: PDF, DOCX, XLSX, PPTX, PNG, JPG, TXT, up to 3 MB, and the file contents must match the type. Up to 50 bots and 50 documents per site; 5 open bot requests per operator.
- Visitors read a site's items from `GET /api/site-library?host=<site domain>` (list) and `...&id=<bot id>` (one bot with its file). Only live items of active sites are returned, with no owner details. **The trading site still has to call this** (or read the same tables) to show them next to the central library; that change is in the `epm-botbuilder` repo and is not part of this step.
