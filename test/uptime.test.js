/* Uptime math + samples storage. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeUptime, uptimeCsv } = require('../server/uptime');
const { Store } = require('../server/db');

test('computeUptime: all operational -> 100, no downtime', () => {
  const r = computeUptime({ operational: 288 }, 300000);
  assert.equal(r.uptime_pct, 100);
  assert.equal(r.downtime_minutes, 0);
});

test('computeUptime: half degraded -> 50, downtime in minutes', () => {
  const r = computeUptime({ operational: 144, degraded: 144 }, 300000);
  assert.equal(r.uptime_pct, 50);
  assert.equal(r.downtime_minutes, 720); /* 144 polls x 5 min */
});

test('computeUptime: maintenance and unknown excluded from denominator', () => {
  const r = computeUptime({ operational: 100, maintenance: 50, unknown: 50 }, 300000);
  assert.equal(r.uptime_pct, 100);
  const empty = computeUptime({}, 300000);
  assert.equal(empty.uptime_pct, null);
  const onlyMaint = computeUptime({ maintenance: 10 }, 300000);
  assert.equal(onlyMaint.uptime_pct, null);
});

test('computeUptime: major/partial count as down', () => {
  const r = computeUptime({ operational: 90, partial_outage: 5, major_outage: 5 }, 300000);
  assert.equal(r.uptime_pct, 90);
  assert.equal(r.downtime_minutes, 50);
});

test('samples: record, aggregate counts, prune old', () => {
  const store = new Store(':memory:');
  const now = new Date('2026-10-27T12:00:00.000Z');
  for (let i = 0; i < 10; i++) store.recordSample(new Date(now - i * 300000).toISOString(), 'slack', 'operational');
  for (let i = 0; i < 2; i++) store.recordSample(new Date(now - i * 300000).toISOString(), 'slack', 'degraded');
  store.recordSample('2026-01-01T00:00:00.000Z', 'slack', 'operational');
  store.recordSample('2026-01-01T00:00:00.000Z', 'github', 'operational');
  const counts = store.getUptimeCounts('2026-10-01T00:00:00.000Z');
  assert.deepEqual(counts.slack, { operational: 10, degraded: 2 });
  assert.equal(counts.github, undefined);
  const pruned = store.pruneSamples('2026-10-01T00:00:00.000Z');
  assert.equal(pruned, 2);
  const after = store.getUptimeCounts('2020-01-01T00:00:00.000Z');
  assert.equal(after.github, undefined);
});

test('uptimeCsv: header, rows, comma escaping', () => {
  const rows = [
    { key: 'slack', name: 'Slack', uptime_pct: 99.5, downtime_minutes: 120, polls: 1000 },
    { key: 'acme', name: 'Acme, Inc.', uptime_pct: null, downtime_minutes: 0, polls: 0 }
  ];
  const csv = uptimeCsv(rows, { days: 30, start: '2026-09-27T00:00:00.000Z', end: '2026-10-27T00:00:00.000Z' });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'vendor,name,uptime_pct,downtime_minutes,polls,period_days,period_start,period_end');
  assert.match(lines[1], /^slack,Slack,99.5,120,1000,30,/);
  assert.match(lines[2], /^acme,"Acme, Inc\.",,0,0,30,/);
});
