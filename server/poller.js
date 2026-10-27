/* Feed poller: fetches every vendor on an interval, stores results, and keeps
   per-vendor feed-health bookkeeping. Production behaviors that matter:
   - One vendor's failure never blocks or blanks the others.
   - On failure the last good result is kept and served (marked via health);
     a vendor only shows "unknown" if it has never succeeded.
   - Shape drift is flagged: a feed that suddenly returns 0 components after
     previously returning some is a classic silent parser break. */
'use strict';

const { fetchVendor, S } = require('./parsers');

const STATUS_LABEL = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial outage',
  major_outage: 'Major outage',
  maintenance: 'Maintenance',
  unknown: 'Unknown'
};

function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

class Poller {
  constructor(store, vendors, opts = {}) {
    this.store = store;
    this.vendors = vendors;
    this.intervalMs = opts.intervalMs || 5 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.concurrency = opts.concurrency || 8;
    this.alerter = opts.alerter || null;
    this.retentionDays = opts.retentionDays || 90;
    this.timer = null;
    this.polling = false;
    this.lastPollAt = null;
    this.lastPollDurationMs = null;
  }

  toService(vendor, result, fetchedAt, errorMessage) {
    return {
      key: vendor.key,
      name: vendor.name,
      category: vendor.category,
      logo: vendor.logo,
      overall_status: result.status,
      overall_label: result.summary || STATUS_LABEL[result.status] || result.status,
      components: (result.components || []).map(c => ({ name: c.name, status: c.status, group: c.group || null })),
      incidents: (result.incidents || []).map(i => ({
        name: i.title,
        status: i.status,
        impact: i.impact || '',
        description: i.body || '',
        url: i.url || null,
        updated_at: i.created || null
      })),
      source_url: vendor.source_url,
      status_page_url: vendor.status_page_url,
      support_url: vendor.support_url,
      support_label: vendor.support_label,
      note: result.note || '',
      fetched_at: fetchedAt,
      error_message: errorMessage || null
    };
  }

  async pollVendor(vendor) {
    const health = this.store.getHealth()[vendor.key] || {
      last_attempt_at: null, last_success_at: null, last_error: null,
      consecutive_failures: 0, last_duration_ms: null, components_count: null, shape_warning: false
    };
    const started = Date.now();
    health.last_attempt_at = new Date().toISOString();
    try {
      const result = await fetchVendor(vendor, { timeoutMs: this.timeoutMs });
      const fetchedAt = new Date().toISOString();
      const prevCount = health.components_count;
      const count = (result.components || []).length;
      health.shape_warning = prevCount != null && prevCount > 0 && count === 0;
      health.components_count = count;
      health.last_success_at = fetchedAt;
      health.last_error = null;
      health.consecutive_failures = 0;
      health.last_duration_ms = Date.now() - started;
      health.last_status = result.status;
      this.store.saveHealth(vendor.key, health);
      this.store.saveLatest(vendor.key, this.toService(vendor, result, fetchedAt, null), fetchedAt);
      this.store.recordSample(fetchedAt, vendor.key, result.status);
      return { key: vendor.key, ok: true, status: result.status };
    } catch (e) {
      health.last_error = String(e && e.message || e);
      health.consecutive_failures += 1;
      health.last_duration_ms = Date.now() - started;
      this.store.saveHealth(vendor.key, health);
      this.store.recordSample(new Date().toISOString(), vendor.key, 'unknown');
      /* keep serving the last good result; only a never-succeeded vendor goes unknown */
      const existing = this.store.getLatest().find(r => r.key === vendor.key);
      if (!existing) {
        const fetchedAt = new Date().toISOString();
        const unknown = {
          status: S.UNK, summary: 'Feed unreachable', components: [], incidents: [],
          updatedAt: null, note: 'This vendor’s feed could not be loaded. Open the official status page for live info.'
        };
        const svc = this.toService(vendor, unknown, fetchedAt, health.last_error);
        this.store.saveLatest(vendor.key, svc, fetchedAt);
      }
      return { key: vendor.key, ok: false, error: health.last_error };
    }
  }

  async pollAll() {
    if (this.polling) return { skipped: true };
    this.polling = true;
    const started = Date.now();
    const queue = [...this.vendors];
    const results = [];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      while (queue.length) {
        const v = queue.shift();
        results.push(await this.pollVendor(v));
      }
    });
    await Promise.all(workers);
    this.lastPollAt = new Date().toISOString();
    this.lastPollDurationMs = Date.now() - started;
    try {
      this.store.pruneSamples(new Date(Date.now() - this.retentionDays * 86400000).toISOString());
    } catch (e) { console.error('[poller] sample prune failed:', e.message); }
    if (this.alerter && this.alerter.enabled) {
      const byKey = new Map(this.store.getLatest().map(r => [r.key, r.payload]));
      for (const v of this.vendors) {
        const svc = byKey.get(v.key);
        if (svc) {
          try { await this.alerter.process(svc, new Date(this.lastPollAt)); }
          catch (e) { console.error('[alerts] process failed for', v.key, e); }
        }
      }
    }
    this.writeDailyRollup();
    this.polling = false;
    return {
      polled: results.length,
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).map(r => r.key),
      durationMs: this.lastPollDurationMs
    };
  }

  /* one record per NY day; the day's last poll wins (end-of-day state) */
  writeDailyRollup() {
    const date = nyDate();
    const vendors = {};
    for (const row of this.store.getLatest()) {
      const active = (row.payload.incidents || []).filter(i =>
        !/^(resolved|completed|scheduled)$/i.test(String(i.status || ''))).length;
      vendors[row.key] = { status: row.payload.overall_status, incidents: active };
    }
    this.store.saveHistoryDay(date, { date, taken_at: this.lastPollAt, vendors });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollAll().catch(e => console.error('[poller] cycle failed:', e));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Poller, STATUS_LABEL, nyDate };
