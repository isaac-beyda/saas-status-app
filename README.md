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

## Favorites

Each viewer can star up to **10 vendors**; starred vendors pin to a
"Your favorites" section at the top (severity-sorted). Favorites are stored
in the browser's `localStorage` (`ssa-favorites-v1`) — per person, per
browser, no account needed.

Upgrade path: behind SSO, key favorites server-side by the authenticated
user (add a `/api/favorites` route reading the same header described under
Authentication, store rows in SQLite, and swap the localStorage calls in
`public/app.js`).

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
