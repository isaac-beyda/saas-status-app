/* Live smoke check: one real poll of all 50 vendor feeds against a throwaway
   DB. Exits non-zero if more than 2 vendors fail or land on unknown.
   Run: npm run smoke */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/db');
const { Poller } = require('../server/poller');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-smoke-'));
  const store = new Store(path.join(tmp, 'smoke.db'));
  const vendors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'vendors.json'), 'utf8'));
  const poller = new Poller(store, vendors, { intervalMs: 300000, timeoutMs: 20000 });
  const r = await poller.pollAll();
  const services = store.getLatest().map(x => x.payload);
  const unknown = services.filter(s => s.overall_status === 'unknown').map(s => s.key);
  const nonOp = services.filter(s => s.overall_status !== 'operational' && s.overall_status !== 'unknown');
  console.log(`polled ${r.polled} vendors in ${r.durationMs}ms — ok ${r.ok}, failed ${r.failed.length}`);
  console.log('non-operational:', nonOp.map(s => `${s.key}=${s.overall_status}`).join(', ') || 'none');
  console.log('unknown:', unknown.join(', ') || 'none');
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.failed.length > 2 || unknown.length > 2) {
    console.error('SMOKE FAILED: too many failed/unknown vendors');
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch(e => { console.error(e); process.exit(1); });
