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

/* --- Wave 1 additions: channels + component filters + SMTP --- */
const { buildPayloads, buildEmail } = require('../server/alerter');
const { sendMail } = require('../server/smtp');
const net = require('node:net');

const evtBase = {
  event: 'outage', vendor_key: 'aws', vendor_name: 'AWS',
  from_status: 'operational', to_status: 'partial_outage',
  summary: 'Elevated errors', affected_functions: 3, total_functions: 40,
  affected_component_names: ['us-east-1', 'EC2'],
  status_page_url: 'https://health.aws.amazon.com/health/status',
  dashboard_url: 'https://status.example.com', subscription: 'core',
  ts: '2026-10-26T21:00:00.000Z'
};

test('payloads: teams adaptive card, discord embed, googlechat card', () => {
  const t = buildPayloads({ type: 'teams', url: 'https://x' }, evtBase);
  assert.equal(t.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.match(t.attachments[0].content.body[0].text, /AWS/);
  const d = buildPayloads({ type: 'discord', url: 'https://x' }, evtBase);
  assert.equal(d.embeds[0].color, 0xe67e22); /* partial = orange */
  assert.match(d.embeds[0].description, /us-east-1/);
  const g = buildPayloads({ type: 'googlechat', url: 'https://x' }, evtBase);
  assert.equal(g.cardsV2[0].card.header.title, 'AWS');
});

test('payloads: pagerduty trigger on outage, resolve on recovery, same dedup key', () => {
  const trig = buildPayloads({ type: 'pagerduty', routing_key: 'RK' }, evtBase);
  assert.equal(trig.event_action, 'trigger');
  assert.equal(trig.routing_key, 'RK');
  assert.equal(trig.payload.severity, 'error');
  const rec = buildPayloads({ type: 'pagerduty', routing_key: 'RK' }, { ...evtBase, event: 'recovery', from_status: 'partial_outage', to_status: 'operational' });
  assert.equal(rec.event_action, 'resolve');
  assert.equal(rec.dedup_key, trig.dedup_key);
});

test('payloads: email subject and body', () => {
  const m = buildEmail({ type: 'email', to: 'ops@example.com' }, evtBase);
  assert.match(m.subject, /AWS/);
  assert.match(m.text, /us-east-1/);
  assert.equal(m.to[0], 'ops@example.com');
});

function svcComp(key, status, compNames) {
  return {
    key, name: key.toUpperCase(), overall_status: status, overall_label: status,
    components: compNames.map(n => ({ name: n, status: status === 'operational' ? 'operational' : 'degraded' })),
    incidents: [], status_page_url: 'https://status.' + key + '.com'
  };
}

test('component filter: only matching affected components alert', async () => {
  const sub = { name: 'aws-east', vendors: ['aws'], components: { aws: ['us-east-1'] }, channels: [{ type: 'webhook', url: 'https://x.example/h' }], events: ['outage', 'recovery'], min_severity: 'degraded' };
  const { alerter, sent } = makeAlerter([sub]);
  await alerter.process(svcComp('aws', 'operational', ['us-east-1', 'eu-west-1']), T(0));
  await alerter.process(svcComp('aws', 'degraded', ['eu-west-1']), T(1)); /* only eu-west down */
  assert.equal(sent.length, 0, 'eu-west-only outage must not alert an east-only subscription');
  await alerter.process(svcComp('aws', 'degraded', ['us-east-1']), T(2));
  assert.equal(sent.length, 1, 'us-east-1 outage must alert');
  assert.match(JSON.stringify(sent[0].payload), /us-east-1/);
});

test('component filter absent for a vendor keeps whole-vendor behavior', async () => {
  const sub = { name: 'mixed', vendors: ['aws', 'github'], components: { aws: ['us-east-1'] }, channels: [{ type: 'webhook', url: 'https://x.example/h' }], events: ['outage', 'recovery'], min_severity: 'degraded' };
  const { alerter, sent } = makeAlerter([sub]);
  await alerter.process(svcComp('github', 'operational', ['API']), T(0));
  await alerter.process(svcComp('github', 'degraded', ['API']), T(1));
  await alerter.process(svcComp('github', 'degraded', ['API']), T(2));
  assert.equal(sent.length, 1, 'github has no component entry, so whole-vendor alerts still fire');
});

test('smtp: delivers a message to a fake plain server (AUTH LOGIN)', async () => {
  let captured = '';
  const server = net.createServer((sock) => {
    let buf = ''; let stage = 'banner'; let inData = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const processLines = () => {
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (inData) {
            if (line === '.') { inData = false; captured += ''; sock.write('250 OK\r\n'); }
            else captured += line + '\n';
            continue;
          }
          if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (line === 'AUTH LOGIN') { stage = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (stage === 'user') { stage = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (stage === 'pass') { stage = 'authd'; sock.write('235 OK\r\n'); }
          else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
          else if (line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
          else if (line === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); }
          else if (line === 'QUIT') sock.write('221 Bye\r\n');
        }
      };
      processLines();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await sendMail({ smtp_host: '127.0.0.1', smtp_port: port, smtp_secure: 'none', smtp_user: 'u', smtp_pass: 'p' },
      { from: 'saas@example.com', to: ['ops@example.com'], subject: 'Test', text: 'hello world' });
    assert.equal(res.ok, true);
    assert.match(captured, /Subject: Test/);
    assert.match(captured, /hello world/);
  } finally {
    server.close();
  }
});
