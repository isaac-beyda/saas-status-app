/* SaaS Status — standalone internal deployment.
   Backend aggregator + API + static frontend in one process.
   Config via env (see .env.example):
     PORT (8080), DB_PATH (./data/status.db), POLL_INTERVAL_MS (300000),
     FETCH_TIMEOUT_MS (20000), AUTH_HEADER (optional, e.g. "x-auth-user" —
     when set, /api/* requires that header; use behind an SSO reverse proxy). */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('./db');
const { Poller } = require('./poller');
const { Alerter, loadAlertConfig } = require('./alerter');
const { loadBoardsConfig, boardByName, filterByBoard } = require('./boards');
const { computeUptime, uptimeCsv } = require('./uptime');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'status.db');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const UPTIME_RETENTION_DAYS = Number(process.env.UPTIME_RETENTION_DAYS || 90);
const AUTH_HEADER = (process.env.AUTH_HEADER || '').toLowerCase();

const vendors = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendors.json'), 'utf8'));
const boards = loadBoardsConfig(process.env);
const store = new Store(DB_PATH);
const alertConfig = loadAlertConfig(process.env);
const alerter = new Alerter(store, alertConfig);
const poller = new Poller(store, vendors, { intervalMs: POLL_INTERVAL_MS, timeoutMs: FETCH_TIMEOUT_MS, alerter, retentionDays: UPTIME_RETENTION_DAYS });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function statusesPayload(boardName) {
  const rows = store.getLatest();
  const byKey = new Map(rows.map(r => [r.key, r.payload]));
  let services = vendors.map(v => byKey.get(v.key)).filter(Boolean);
  let board = null;
  if (boardName) {
    board = boardByName(boards, boardName);
    if (!board) return null;
    services = filterByBoard(services, board);
  }
  const lastRefreshed = rows.length
    ? rows.map(r => r.fetched_at).sort().pop()
    : null;
  return { last_refreshed: lastRefreshed, board: board ? board.name : null, services };
}

function healthPayload() {
  const health = store.getHealth();
  const now = Date.now();
  const vendorsOut = {};
  let healthy = 0, failing = 0, stale = 0;
  for (const v of vendors) {
    const h = health[v.key] || null;
    const lastSuccess = h && h.last_success_at ? new Date(h.last_success_at).getTime() : 0;
    const isStale = !lastSuccess || (now - lastSuccess) > POLL_INTERVAL_MS * 3;
    if (isStale) stale += 1;
    if (h && h.consecutive_failures > 0) failing += 1; else healthy += 1;
    vendorsOut[v.key] = h ? { ...h, stale: isStale } : { never_polled: true, stale: true };
  }
  return {
    ok: failing === 0,
    poll_interval_ms: POLL_INTERVAL_MS,
    last_poll_at: poller.lastPollAt,
    last_poll_duration_ms: poller.lastPollDurationMs,
    totals: { vendors: vendors.length, healthy, failing, stale },
    vendors: vendorsOut
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });

  if (p.startsWith('/api/')) {
    if (AUTH_HEADER && !req.headers[AUTH_HEADER]) {
      return sendJson(res, 401, { error: 'unauthorized: missing ' + AUTH_HEADER + ' header (SSO proxy auth)' });
    }
    try {
      if (p === '/api/statuses' && req.method === 'GET') {
        const payload = statusesPayload(url.searchParams.get('board') || null);
        if (!payload) return sendJson(res, 404, { error: 'unknown board' });
        return sendJson(res, 200, payload);
      }
      if (p === '/api/boards' && req.method === 'GET') {
        return sendJson(res, 200, {
          boards: boards.map(b => ({
            name: b.name,
            title: b.title,
            vendor_count: b.vendors === '*' ? vendors.length : b.vendors.filter(k => vendors.some(v => v.key === k)).length
          }))
        });
      }
      if ((p === '/api/uptime' || p === '/api/uptime.csv') && req.method === 'GET') {
        const days = Math.max(1, Math.min(UPTIME_RETENTION_DAYS, Number(url.searchParams.get('days') || 30) || 30));
        const now = Date.now();
        const since = new Date(now - days * 86400000).toISOString();
        const counts = store.getUptimeCounts(since);
        let list = vendors;
        const boardName = url.searchParams.get('board');
        if (boardName) {
          const board = boardByName(boards, boardName);
          if (!board) return sendJson(res, 404, { error: 'unknown board' });
          list = filterByBoard(vendors, board);
        }
        const vendorParam = url.searchParams.get('vendor');
        if (vendorParam) list = list.filter(v => v.key === vendorParam);
        const period = { days, start: since, end: new Date(now).toISOString() };
        const rows = list.map(v => {
          const c = computeUptime(counts[v.key] || {}, POLL_INTERVAL_MS);
          return { key: v.key, name: v.name, ...c };
        }).sort((a, b) => (a.uptime_pct == null ? 101 : a.uptime_pct) - (b.uptime_pct == null ? 101 : b.uptime_pct));
        if (p === '/api/uptime.csv') {
          const body = uptimeCsv(rows, period);
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="saas-uptime-' + days + 'd.csv"',
            'cache-control': 'no-store'
          });
          return res.end(body);
        }
        return sendJson(res, 200, { period_days: period.days, period_start: period.start, period_end: period.end, poll_interval_ms: POLL_INTERVAL_MS, vendors: rows });
      }
      if (p === '/api/health' && req.method === 'GET') return sendJson(res, 200, healthPayload());
      if (p === '/api/history' && req.method === 'GET') {
        const days = store.getHistory();
        return sendJson(res, 200, { updated: days.length ? days[days.length - 1].date : null, days });
      }
      if (p === '/api/refresh' && req.method === 'POST') {
        const r = await poller.pollAll();
        return sendJson(res, 200, r);
      }
      if (p === '/api/alerts' && req.method === 'GET') {
        return sendJson(res, 200, { ...alerter.summary(), recent: store.getAlerts(100) });
      }
      if (p === '/api/alerts/test' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        const name = await new Promise((resolve) => {
          req.on('end', () => {
            try { resolve(JSON.parse(body || '{}').subscription || null); }
            catch { resolve(null); }
          });
        });
        const r = await alerter.sendTest(name);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[api]', e);
      return sendJson(res, 500, { error: String(e && e.message || e) });
    }
  }

  /* static frontend */
  let file = p === '/' ? '/index.html' : p;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      /* SPA fallback */
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, buf) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(buf);
      });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(full).pipe(res);
  });
});

async function main() {
  server.listen(PORT, () => {
    console.log(`[saas-status] listening on :${PORT} — polling ${vendors.length} vendors every ${POLL_INTERVAL_MS}ms`);
  });
  poller.start();
  const r = await poller.pollAll();
  console.log(`[saas-status] initial poll: ${r.ok}/${r.polled} ok in ${r.durationMs}ms` +
    (r.failed && r.failed.length ? ` — failed: ${r.failed.join(', ')}` : ''));
  console.log(alerter.enabled
    ? `[saas-status] alerting enabled: ${alertConfig.subscriptions.map(s => s.name).join(', ')} (confirm after ${alertConfig.confirm_polls} polls)`
    : '[saas-status] alerting disabled (set ALERTS_CONFIG or ALERT_SLACK_WEBHOOK/ALERT_WEBHOOK_URL)');
}

main().catch(e => { console.error(e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    poller.stop();
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
