/* Alerter engine tests — fake store + capturing sender, no network.
   Covers the anti-spam contract: confirmation polls, recovery pairing,
   per-subscription severity/vendor filters, flap suppression, daily cap. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Alerter, classifyTransition, normalizeConfig, loadAlertConfig } = require('../server/alerter');

function fakeStore() {
  const states = new Map();
  const logs = [];
  return {
    states, logs,
    getAlertState: (k) => states.get(k) || null,
    saveAlertState: (k, v) => states.set(k, v),
    logAlert: (e) => logs.push(e),
    getAlerts: () => logs
  };
}

function makeAlerter(subs, extra = {}) {
  const sent = [];
  const store = fakeStore();
  const config = normalizeConfig({
    confirm_polls: 2, max_alerts_per_vendor_day: 10, dashboard_url: 'https://status.example.com',
    subscriptions: subs
  }, {});
  const alerter = new Alerter(store, config, {
    send: async (channel, payload) => { sent.push({ channel: channel.type, payload }); return { ok: true, status: 200 }; }
  });
  return { alerter, sent, store };
}

const svc = (key, status, label = '') => ({
  key, name: key[0].toUpperCase() + key.slice(1), overall_status: status, overall_label: label || status,
  components: [{ name: 'API', status: status === 'operational' ? 'operational' : 'degraded' }],
  incidents: status === 'operational' ? [] : [{ name: 'Something broke', status: 'investigating' }],
  status_page_url: 'https://status.' + key + '.com'
});
const T = (s) => new Date('2026-10-20T12:00:0' + s + 'Z');

const slackSub = { name: 'core', vendors: ['slack'], channels: [{ type: 'slack', url: 'https://hooks.example/x' }], events: ['outage', 'recovery', 'maintenance'], min_severity: 'degraded' };

test('classifyTransition: basic directions', () => {
  assert.equal(classifyTransition('operational', 'degraded', []), 'outage');
  assert.equal(classifyTransition('operational', 'maintenance', []), 'maintenance');
  assert.equal(classifyTransition('degraded', 'operational', []), null); /* never alerted */
  assert.equal(classifyTransition('degraded', 'operational', ['core']), 'recovery');
  assert.equal(classifyTransition('partial_outage', 'degraded', ['core']), 'improvement');
  assert.equal(classifyTransition('partial_outage', 'degraded', []), null);
});

test('first sight adopts status silently (no deploy-time storm)', async () => {
  const { alerter, sent } = makeAlerter([slackSub]);
  await alerter.process(svc('slack', 'degraded'), T(0));
  await alerter.process(svc('slack', 'degraded'), T(1));
  assert.equal(sent.length, 0);
});

test('outage fires only after confirm_polls consecutive sightings', async () => {
  const { alerter, sent } = makeAlerter([slackSub]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'degraded'), T(1));
  assert.equal(sent.length, 0); /* first sighting: pending */
  await alerter.process(svc('slack', 'degraded'), T(2));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /Slack — Degraded/);
  await alerter.process(svc('slack', 'degraded'), T(3));
  assert.equal(sent.length, 1); /* steady state: no repeats */
});

test('flapping vendor produces no alerts at all', async () => {
  const { alerter, sent } = makeAlerter([slackSub]);
  await alerter.process(svc('slack', 'operational'), T(0));
  for (let i = 1; i <= 6; i++) {
    await alerter.process(svc('slack', i % 2 ? 'degraded' : 'operational'), T(i));
  }
  assert.equal(sent.length, 0);
});

test('recovery goes only to subscriptions that got the outage', async () => {
  const other = { name: 'other', vendors: ['slack'], channels: [{ type: 'webhook', url: 'https://x.example/hook' }], events: ['outage', 'recovery'], min_severity: 'major_outage' };
  const { alerter, sent } = makeAlerter([slackSub, other]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'degraded'), T(1));
  await alerter.process(svc('slack', 'degraded'), T(2));
  assert.equal(sent.length, 1); /* only 'core' (other wants major+) */
  assert.equal(sent[0].channel, 'slack');
  await alerter.process(svc('slack', 'operational'), T(3));
  await alerter.process(svc('slack', 'operational'), T(4));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].channel, 'slack'); /* recovery only to core */
  assert.match(sent[1].payload.text, /Operational/);
});

test('escalation while alerted fires as a new outage event', async () => {
  const { alerter, sent } = makeAlerter([slackSub]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'degraded'), T(1));
  await alerter.process(svc('slack', 'degraded'), T(2));
  await alerter.process(svc('slack', 'partial_outage'), T(3));
  await alerter.process(svc('slack', 'partial_outage'), T(4));
  assert.equal(sent.length, 2);
  assert.match(sent[1].payload.text, /Partial outage/);
});

test('vendor filter: subscription for other vendors stays silent', async () => {
  const gh = { name: 'gh-only', vendors: ['github'], channels: [{ type: 'webhook', url: 'https://x.example/h' }], events: ['outage', 'recovery'], min_severity: 'degraded' };
  const { alerter, sent } = makeAlerter([gh]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'major_outage'), T(1));
  await alerter.process(svc('slack', 'major_outage'), T(2));
  assert.equal(sent.length, 0);
});

test('unknown (feed failure) never alerts and does not disturb state', async () => {
  const { alerter, sent, store } = makeAlerter([slackSub]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'unknown'), T(1));
  await alerter.process(svc('slack', 'degraded'), T(2));
  await alerter.process(svc('slack', 'degraded'), T(3));
  assert.equal(sent.length, 1);
  assert.equal(store.states.get('slack').stable, 'degraded');
});

test('daily cap suppresses and logs', async () => {
  const { alerter, sent, store } = makeAlerter([slackSub], {});
  alerter.config.max_alerts_per_vendor_day = 1;
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'degraded'), T(1));
  await alerter.process(svc('slack', 'degraded'), T(2)); /* fires (1) */
  await alerter.process(svc('slack', 'operational'), T(3));
  await alerter.process(svc('slack', 'operational'), T(4)); /* recovery: capped */
  assert.equal(sent.length, 1);
  assert.ok(store.logs.some(l => l.suppressed === 'daily_cap' && l.event === 'recovery'));
});

test('maintenance event respects subscription event list', async () => {
  const noMaint = { name: 'nm', vendors: '*', channels: [{ type: 'webhook', url: 'https://x.example/h' }], events: ['outage', 'recovery'], min_severity: 'degraded' };
  const { alerter, sent } = makeAlerter([slackSub, noMaint]);
  await alerter.process(svc('slack', 'operational'), T(0));
  await alerter.process(svc('slack', 'maintenance'), T(1));
  await alerter.process(svc('slack', 'maintenance'), T(2));
  assert.equal(sent.length, 1); /* only core (has maintenance), via slack */
  assert.equal(sent[0].channel, 'slack');
});

test('loadAlertConfig: env webhook fallback builds a default subscription', () => {
  const cfg = loadAlertConfig({ ALERT_SLACK_WEBHOOK: 'https://hooks.example/x' });
  assert.equal(cfg.subscriptions.length, 1);
  assert.equal(cfg.subscriptions[0].name, 'default');
  assert.equal(loadAlertConfig({}), null);
});

test('sendTest delivers to the named subscription only', async () => {
  const { alerter, sent } = makeAlerter([slackSub]);
  const r = await alerter.sendTest('core');
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /test alert/i);
  const bad = await alerter.sendTest('nope');
  assert.equal(bad.ok, false);
});
