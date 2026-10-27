# SaaS Status — internal vendor status console

One dashboard for the live status of 50 SaaS vendors, down to the individual
function/component level, sourced exclusively from each vendor's **official**
public status feed. Built to run inside a company network as a single
containerized Node.js service — no external dependencies, no npm packages.

## Architecture

```
vendor feeds (50 official sources)
        │  server-side poll every 5 min (configurable)
        ▼
┌────────────────────────────┐      ┌──────────────────┐
│ Poller + parsers (server/) │─────▶│ SQLite (node:sqlite)│
│ - per-vendor normalizers   │      │ latest / health /  │
│ - derived status rules     │      │ daily history      │
└────────────────────────────┘      └──────────────────┘
        │  GET /api/statuses · /api/health · /api/history
        ▼
Frontend (public/) — KPIs, search/filter, expandable function &
incident detail, and per-user Favorites (top 10, see below)
```

Why a backend at all: several vendor feeds (Docker, Intercom, Microsoft,
PagerDuty, Zendesk) cannot be read from a browser at all (CORS / no public
browser API), and per-visitor fetching doesn't scale. The server polls once
and serves everyone the same cached view.

## Status derivation rules (important)

Overall status is **derived**, never copied from a feed's headline:

- Worst live component state sets the base (group/container components are
  excluded; their names label their children).
- Active incidents floor the status by impact (minor → degraded,
  major → partial, critical → major).
- **Future scheduled maintenance never affects current status.** (This was a
  real bug: Auth0 showed "degraded" for days over a no-impact DNS change
  scheduled a week out.)
- In-progress maintenance yields `maintenance`, reported separately from
  breakage — maintenance components never count as "affected functions".
- Retired/deprecated components are filtered where a vendor leaves them in
  a stale failure state (Auth0's deprecated preview environments).

Vendor-specific sources worth knowing:

| Vendor | Source | Note |
|---|---|---|
| AWS | Health API `public/currentevents` | Serves UTF-16 JSON; open events only, `impacted_services` expands to per-service components. RSS fallback if the API is down. No full catalog exists. |
| Microsoft | `status.cloud.microsoft/api/posts/azure` + built-in service catalog | Posts are advisories; services named in a post are marked degraded. Provider-level signal. |
| PagerDuty | `status.pagerduty.com/api/services` + `/api/impacted_services` | Component status = presence in the impacted list. |
| Zendesk | SSP incidents API | Service list is derived from services referenced by recent incidents. |
| Salesforce | Trust API incidents + products | Product `incidentCount`/`maintenanceCount` carry health — incidents alone miss maintenance. |
| Google Workspace | Apps Status incidents + products catalog | |
| Everyone else | statuspage.io `summary.json` (or vendor equivalent) | GitLab uses status.io; Slack a custom active-incidents API; Docker/Intercom use incident.io RSS. |

## Favorites (per viewer)

The dashboard tracks 50 vendors; favorites keep your own stack on top.

1. Click the ☆ on any vendor card to star it.
2. Starred vendors collect in a **Your favorites** section pinned above the
   full grid, worst-status-first, with a counter (e.g. `7/10`).
3. Click the star again to unstar.
4. The cap is **10** — starring an 11th shows a toast; unstar one first.

Favorites are stored in the browser's `localStorage` (`ssa-favorites-v1`) —
per person, per browser, no account and no server state. Clearing site data
resets them. Upgrade path if this ever runs behind SSO: key favorites
server-side by the authenticated user (a `/api/favorites` route reading the
header described under Authentication, rows in SQLite, and the localStorage
calls in `public/app.js` swapped for API calls).

## Boards

Boards are named vendor sets — one dashboard per team, client, or stack —
in the StatusGator style. Define them in `boards.json` (copy
`boards.example.json` and edit; without a file you get a single "All
vendors" board):

```json
{ "boards": [
  { "name": "core", "title": "Core stack", "vendors": ["slack", "github", "aws"] },
  { "name": "all", "title": "All vendors", "vendors": "*" }
] }
```

Pick a board in the switcher at the top of the dashboard, or share it
directly: `/board/core` or `?board=core`. The API honors the same filter
(`/api/statuses?board=core`); `/api/boards` lists boards with vendor
counts. Board names are lowercase URL slugs. A board is a view, not an
alert rule — mirror its vendor list in an alert subscription if you want
that board's team paged too.

## Running

Local (Node ≥ 22.5, nothing to install):

```bash
cp .env.example .env   # optional; defaults work as-is
npm start              # http://localhost:8080
```

Docker:

```bash
docker compose up -d --build
curl localhost:8080/healthz
```

Tests (offline, synthetic fixtures) and a live smoke check (one real poll):

```bash
npm test
npm run smoke
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `DB_PATH` | `./data/status.db` | SQLite file (put on a persistent volume) |
| `POLL_INTERVAL_MS` | `300000` | Feed poll interval (5 min) |
| `FETCH_TIMEOUT_MS` | `20000` | Per-vendor fetch timeout |
| `AUTH_HEADER` | *(unset)* | If set, `/api/*` requires this header — see below |

## Alerting

Subscriptions turn status changes into notifications (Slack incoming
webhooks and/or generic JSON webhooks — the generic payload works for
Teams connectors, PagerDuty-compatible endpoints, or your own receiver).

### Set it up (Slack example)

1. **Get a webhook URL.** In Slack: *Apps → Incoming Webhooks → Add to
   Slack*, pick a channel, copy the `https://hooks.slack.com/services/…`
   URL. Treat it like a password.
2. **Create your config:** `cp alerts.example.json alerts.json`, then edit:
   paste the webhook URL, list the vendor keys you care about (`"*"` for
   all — keys are in `server/vendors.json` and every `/api/statuses`
   entry), set `min_severity`, and pick events (`outage`, `recovery`,
   `maintenance`, `improvement`).
3. **Start (or restart) with alerting on:**
   `ALERTS_CONFIG=./alerts.json npm start` — the boot log confirms
   `alerting enabled: <subscription names> (confirm after N polls)`.
   Editing `alerts.json` requires a restart.
4. **Send a test** (below) — a 🧪 message should land in the channel
   within seconds. Then watch real deliveries at `GET /api/alerts`.

Shortcut for one all-vendors subscription, no file: set
`ALERT_SLACK_WEBHOOK=...` and/or `ALERT_WEBHOOK_URL=...` in the environment.

### Channels

One subscription can fan out to many destinations. Supported channel
types (each entry in a subscription's `channels`):

- `slack` — incoming webhook (Block Kit message)
- `teams` — Workflows webhook (Adaptive Card)
- `discord` — webhook (embed)
- `googlechat` — webhook (text + card)
- `webhook` — generic JSON POST (optionally with custom `headers`, which
  also makes it usable for Opsgenie-style APIs)
- `pagerduty` — Events API v2 via `routing_key`; outages trigger and
  recoveries resolve under one dedup key per vendor
- `email` — SMTP: `to`, `smtp_host`, `smtp_port` (default 587),
  `smtp_secure` (`starttls` / `tls` / `none`), `smtp_user`, `smtp_pass`

### Component filters

To alert on part of a vendor instead of the whole thing (StatusGator's
noise-reducer), add a `components` map to a subscription: patterns are
matched case-insensitively against affected component names.

```json
{ "name": "aws-east", "vendors": ["aws"], "components": { "aws": ["us-east-1"] }, "channels": [ ... ] }
```

Vendors without a `components` entry in that subscription keep
whole-vendor behavior.

### How alerts behave

- **Transitions only** — steady states never notify.
- **Confirmation polls** (`confirm_polls`, default 2): a new status must be
  seen in consecutive polls before firing, so a sub-10-minute blip sends
  nothing. Applies to recoveries too — a flapping vendor produces silence.
- **Recovery pairing** — "back to operational" goes only to subscriptions
  that received the outage.
- **Daily cap** per vendor (`max_alerts_per_vendor_day`, default 10);
  suppressed alerts are logged, not sent.
- **Deploying mid-outage is safe** — first sight of a vendor adopts its
  current status silently.
- Feed failures (`unknown`) never alert subscribers; watch `/api/health`
  for those instead.

Inspect and test without waiting for an outage:

```bash
curl localhost:8080/api/alerts                       # config summary + delivery log
curl -X POST localhost:8080/api/alerts/test \
  -H 'content-type: application/json' -d '{"subscription":"core-stack"}'
```

Webhook URLs are secrets: `alerts.json` is gitignored, and `/api/alerts`
never exposes URLs (channel types only).

## Authentication

The app ships without built-in accounts on purpose: deploy it behind your
SSO reverse proxy (Okta / Entra / etc.). Set `AUTH_HEADER` to the header
your proxy injects after authentication (e.g. `x-auth-user`); requests to
`/api/*` without it get 401. On a trusted internal segment you can leave it
unset. Static assets are not gated (they contain no data).

## Self-monitoring

`GET /api/health` reports per-vendor: last attempt/success, last error,
consecutive failures, fetch duration, component count, a **stale** flag
(no success within 3× the poll interval), and a **shape warning** (a feed
that suddenly returns 0 components after previously returning some — the
classic silent parser break when a vendor changes format). The UI header
shows an aggregate "N/N feeds OK" and flags failing feeds on their cards;
on failure the last good status keeps being served rather than blanking.

Wire `ok: false` or any `failing > 0` from `/api/health` into your alerting.

## Operations runbook

- **A vendor shows Unknown**: it has never polled successfully. Check
  `/api/health` for its `last_error`. Common causes: vendor moved the feed
  (update `source_url` in `server/vendors.json`), or the feed is down.
- **A vendor's status looks wrong**: compare against its official status
  page, then check the derivation rules above — a single degraded component
  or an active minor incident is enough to show "Degraded". If the feed's
  shape changed, the parser for that vendor lives in `server/parsers.js`
  (dispatch in `fetchVendor`); add a fixture test in `test/parsers.test.js`
  before changing behavior.
- **Adding a vendor**: add an entry to `server/vendors.json` (statuspage
  vendors need no code). For a non-statuspage source, add a parser +
  dispatch case + tests.
- **History**: `GET /api/history` returns one record per day
  (America/New_York) of per-vendor status + active incident counts — the
  basis for reliability reporting. The stored row is the day's latest poll.
- **Restart behavior**: the DB persists across restarts; the first poll runs
  at boot (~15–25 s for all 50 vendors).

## Known limitations

- AWS publishes no complete service catalog; AWS rows reflect open events
  and their impacted services only.
- Microsoft and Zendesk are provider-level signals (advisory posts /
  incident-referenced services), not full component telemetry.
- Slack publishes active incidents only — no per-function breakdown exists.
