/* Alerting engine: turns poll results into notifications without spamming.
   Rules that keep alerts trustworthy:
   - Only STATUS TRANSITIONS alert — never steady states.
   - A transition must be seen in `confirm_polls` consecutive polls before it
     fires (a 5-minute blip never pages anyone). This applies to recoveries
     too, so a flapping vendor produces nothing.
   - Recovery notices go only to subscriptions that received the outage.
   - Per-vendor daily cap suppresses alert storms from a flapping feed.
   - 'unknown' (our feed failed) never alerts subscribers — that's a
     monitoring problem, surfaced via /api/health instead. */
'use strict';

const fs = require('node:fs');
const { sendMail } = require('./smtp');

/* Channel types and what each needs:
   slack/discord/googlechat/teams/webhook: url (+ optional headers)
   pagerduty: routing_key (Events API v2; outage -> trigger, recovery -> resolve)
   email: to + smtp_host (+ smtp_port/smtp_secure/smtp_user/smtp_pass) */
const CHANNEL_TYPES = ['slack', 'webhook', 'teams', 'discord', 'googlechat', 'pagerduty', 'email'];

const SEV = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };
const LABEL = {
  operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage',
  major_outage: 'Major outage', maintenance: 'Maintenance', unknown: 'Unknown'
};
const EMOJI = {
  outage: '🔴', recovery: '✅', maintenance: '🔧', improvement: '🟡', test: '🧪'
};
const ACTIVE_EXCLUDE = ['resolved', 'completed', 'scheduled', 'postmortem'];

function classifyTransition(from, to, alertedSubs) {
  if (to === 'operational') return alertedSubs.length ? 'recovery' : null;
  if (SEV[to] > SEV[from]) return to === 'maintenance' ? 'maintenance' : 'outage';
  if (SEV[to] < SEV[from]) return alertedSubs.length ? 'improvement' : null;
  return null;
}

function loadAlertConfig(env = process.env, readFile = fs.readFileSync) {
  if (env.ALERTS_CONFIG) {
    try {
      const cfg = JSON.parse(readFile(env.ALERTS_CONFIG, 'utf8'));
      return normalizeConfig(cfg, env);
    } catch (e) {
      console.error('[alerts] failed to load ALERTS_CONFIG:', e.message);
      return null;
    }
  }
  const channels = [];
  if (env.ALERT_SLACK_WEBHOOK) channels.push({ type: 'slack', url: env.ALERT_SLACK_WEBHOOK });
  if (env.ALERT_WEBHOOK_URL) channels.push({ type: 'webhook', url: env.ALERT_WEBHOOK_URL });
  if (!channels.length) return null;
  return normalizeConfig({
    subscriptions: [{ name: 'default', vendors: '*', channels, min_severity: 'degraded', events: ['outage', 'recovery'] }]
  }, env);
}

function normalizeConfig(cfg, env) {
  const subs = [];
  for (const s of cfg.subscriptions || []) {
    if (!s || !s.name || !Array.isArray(s.channels) || !s.channels.length) {
      console.warn('[alerts] skipping subscription without name/channels:', s && s.name);
      continue;
    }
    const channels = [];
    for (const c of s.channels || []) {
      if (!c || !CHANNEL_TYPES.includes(c.type)) { console.warn('[alerts] unknown channel type:', c && c.type); continue; }
      if (c.type === 'pagerduty' && !c.routing_key) { console.warn('[alerts] pagerduty channel without routing_key in', s.name); continue; }
      if (c.type === 'email' && (!c.to || !c.smtp_host)) { console.warn('[alerts] email channel without to/smtp_host in', s.name); continue; }
      if (c.type !== 'pagerduty' && c.type !== 'email' && !c.url) { console.warn('[alerts] channel without url in', s.name); continue; }
      channels.push(c);
    }
    if (!channels.length) { console.warn('[alerts] subscription has no valid channels:', s.name); continue; }
    subs.push({
      name: s.name,
      vendors: s.vendors === '*' || !s.vendors ? '*' : s.vendors,
      components: s.components && typeof s.components === 'object' ? s.components : null,
      channels,
      min_severity: SEV[s.min_severity] != null ? s.min_severity : 'degraded',
      events: Array.isArray(s.events) && s.events.length ? s.events : ['outage', 'recovery']
    });
  }
  if (!subs.length) return null;
  return {
    confirm_polls: Math.max(1, cfg.confirm_polls || 2),
    max_alerts_per_vendor_day: cfg.max_alerts_per_vendor_day || 10,
    dashboard_url: cfg.dashboard_url || env.DASHBOARD_URL || '',
    subscriptions: subs
  };
}

function channelEndpoint(channel) {
  if (channel.type === 'pagerduty') return 'https://events.pagerduty.com/v2/enqueue';
  return channel.url;
}

async function httpSend(channel, payload, fetchFn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 10000);
      const res = await fetchFn(channelEndpoint(channel), {
        method: 'POST',
        signal: c.signal,
        headers: Object.assign({ 'content-type': 'application/json', 'user-agent': 'saas-status-app/1.0' }, channel.headers || {}),
        body: JSON.stringify(payload)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { ok: true, status: res.status };
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { ok: false, error: String(lastErr && lastErr.message || lastErr) };
}

const PD_SEVERITY = { major_outage: 'critical', partial_outage: 'error', degraded: 'warning', maintenance: 'info', operational: 'info' };

function sharedLines(evt) {
  const lines = [];
  if (evt.event !== 'test') {
    lines.push('*Status:* ' + (LABEL[evt.from_status] || evt.from_status) + ' → ' + (LABEL[evt.to_status] || evt.to_status));
  }
  if (evt.summary) lines.push(evt.summary);
  if (evt.affected_component_names && evt.affected_component_names.length) {
    const names = evt.affected_component_names;
    lines.push('*Affected:* ' + names.slice(0, 5).join(', ') + (names.length > 5 ? ' (and ' + (names.length - 5) + ' more)' : ''));
  }
  if (evt.affected_functions != null) {
    lines.push('*Affected functions:* ' + evt.affected_functions + ' of ' + evt.total_functions +
      (evt.top_incident ? '\n*Latest incident:* ' + evt.top_incident : ''));
  }
  return lines;
}

function buildPayloads(channel, evt) {
  const emoji = EMOJI[evt.event] || '🔔';
  const title = evt.event === 'test'
    ? emoji + ' SaaS Status — test alert'
    : emoji + ' ' + evt.vendor_name + ' — ' + (LABEL[evt.to_status] || evt.to_status);
  const lines = sharedLines(evt);
  const links = ['<' + evt.status_page_url + '|Official status page>'];
  if (evt.dashboard_url) links.push('<' + evt.dashboard_url + '|Dashboard>');
  links.push('subscription: ' + evt.subscription);

  if (channel.type === 'slack') {
    return {
      text: title + (evt.summary ? ' — ' + evt.summary : ''),
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || 'Test alert — your subscription is wired up correctly.' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: links.join(' · ') }] }
      ]
    };
  }
  if (channel.type === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: lines.join('\n') || 'Test alert — your subscription is wired up correctly.', wrap: true }
          ],
          actions: evt.status_page_url ? [{ type: 'Action.OpenUrl', title: 'Official status page', url: evt.status_page_url }] : []
        }
      }]
    };
  }
  if (channel.type === 'discord') {
    const color = evt.event === 'recovery' ? 0x2ecc71 : evt.to_status === 'major_outage' ? 0xe74c3c : evt.to_status === 'partial_outage' ? 0xe67e22 : 0xf1c40f;
    return {
      content: title,
      embeds: [{
        title: evt.vendor_name + ' — ' + (LABEL[evt.to_status] || evt.to_status),
        description: lines.join('\n') || 'Test alert — your subscription is wired up correctly.',
        color,
        timestamp: evt.ts,
        footer: { text: 'subscription: ' + evt.subscription }
      }]
    };
  }
  if (channel.type === 'googlechat') {
    return {
      text: title + (lines.length ? '\n' + lines.join('\n') : ''),
      cardsV2: [{
        card: {
          header: { title: evt.vendor_name, subtitle: LABEL[evt.to_status] || evt.to_status },
          sections: [{ widgets: [{ textParagraph: { text: lines.join('\n') || 'Test alert — your subscription is wired up correctly.' } }] }]
        }
      }]
    };
  }
  if (channel.type === 'pagerduty') {
    return {
      routing_key: channel.routing_key,
      dedup_key: 'saas-status:' + evt.vendor_key,
      event_action: evt.event === 'recovery' ? 'resolve' : 'trigger',
      payload: {
        summary: title + (evt.summary ? ' — ' + evt.summary : ''),
        severity: PD_SEVERITY[evt.to_status] || 'warning',
        source: 'saas-status-app',
        component: evt.vendor_name,
        group: evt.subscription,
        custom_details: {
          from_status: evt.from_status,
          to_status: evt.to_status,
          affected_functions: evt.affected_functions,
          total_functions: evt.total_functions,
          affected_components: evt.affected_component_names,
          top_incident: evt.top_incident,
          status_page_url: evt.status_page_url
        }
      }
    };
  }
  /* generic webhook */
  return {
    event: evt.event,
    vendor: { key: evt.vendor_key, name: evt.vendor_name },
    from_status: evt.from_status,
    to_status: evt.to_status,
    summary: evt.summary,
    affected_functions: evt.affected_functions,
    total_functions: evt.total_functions,
    affected_components: evt.affected_component_names,
    top_incident: evt.top_incident,
    status_page_url: evt.status_page_url,
    dashboard_url: evt.dashboard_url || undefined,
    subscription: evt.subscription,
    ts: evt.ts
  };
}

function buildEmail(channel, evt) {
  const emoji = EMOJI[evt.event] || '🔔';
  const title = evt.event === 'test'
    ? emoji + ' SaaS Status — test alert'
    : emoji + ' ' + evt.vendor_name + ' — ' + (LABEL[evt.to_status] || evt.to_status);
  const lines = sharedLines(evt);
  return {
    from: channel.from || 'saas-status@localhost',
    to: [channel.to],
    subject: '[SaaS Status] ' + title,
    text: [title, '', ...lines, '', 'Official status page: ' + evt.status_page_url,
      evt.dashboard_url ? 'Dashboard: ' + evt.dashboard_url : '', 'Subscription: ' + evt.subscription].filter(Boolean).join('\n')
  };
}

class Alerter {
  constructor(store, config, opts = {}) {
    this.store = store;
    this.config = config;
    this.fetchFn = opts.fetch || globalThis.fetch;
    this.send = opts.send || ((channel, payload) => httpSend(channel, payload, this.fetchFn));
    this.sendEmail = opts.sendEmail || ((channel, mail) => sendMail(channel, mail));
  }

  get enabled() { return !!this.config; }

  summary() {
    if (!this.config) return { enabled: false, subscriptions: [] };
    return {
      enabled: true,
      confirm_polls: this.config.confirm_polls,
      max_alerts_per_vendor_day: this.config.max_alerts_per_vendor_day,
      subscriptions: this.config.subscriptions.map(s => ({
        name: s.name,
        vendors: s.vendors === '*' ? 'all' : s.vendors,
        channels: s.channels.map(c => c.type),
        min_severity: s.min_severity,
        events: s.events
      }))
    };
  }

  matches(sub, vendorKey, event, toStatus, componentNames) {
    if (sub.vendors !== '*' && !sub.vendors.includes(vendorKey)) return false;
    if (!sub.events.includes(event)) return false;
    if (event === 'outage' && SEV[toStatus] < SEV[sub.min_severity]) return false;
    /* Component filter: when the subscription names components for this
       vendor, only alert if one of the affected components matches a
       pattern (case-insensitive substring). Vendors without a components
       entry keep whole-vendor behavior. */
    if (sub.components && sub.components[vendorKey] && componentNames) {
      const patterns = sub.components[vendorKey];
      const hit = componentNames.some(n => patterns.some(p => String(n).toLowerCase().includes(String(p).toLowerCase())));
      if (!hit) return false;
    }
    return true;
  }

  /* Feed one vendor's fresh service object; returns fired events. */
  async process(service, now = new Date()) {
    if (!this.config) return [];
    const key = service.key;
    const status = service.overall_status;
    if (!status || status === 'unknown' || SEV[status] == null) return [];

    const today = now.toISOString().slice(0, 10);
    let st = this.store.getAlertState(key);
    if (!st) {
      /* First sight: adopt the current status silently — deploying the
         alerter during an ongoing outage must not storm every channel. */
      st = { stable: status, pending: null, pending_count: 0, alerted_subs: [], peak_status: null, day: today, day_count: 0 };
      this.store.saveAlertState(key, st);
      return [];
    }
    if (st.day !== today) { st.day = today; st.day_count = 0; }

    if (status === st.stable) {
      if (st.pending) { st.pending = null; st.pending_count = 0; this.store.saveAlertState(key, st); }
      return [];
    }
    if (status === st.pending) st.pending_count += 1;
    else { st.pending = status; st.pending_count = 1; }
    if (st.pending_count < this.config.confirm_polls) {
      this.store.saveAlertState(key, st);
      return [];
    }

    const from = st.stable, to = status;
    st.stable = to; st.pending = null; st.pending_count = 0;
    const event = classifyTransition(from, to, st.alerted_subs);
    const fired = [];

    if (event) {
      const bad = (service.components || []).filter(c => ['degraded', 'partial_outage', 'major_outage'].includes(c.status)).map(c => c.name);
      const maint = (service.components || []).filter(c => c.status === 'maintenance').map(c => c.name);
      const relevantNames = event === 'maintenance' ? maint : bad;
      let recipients;
      if (event === 'recovery') {
        recipients = this.config.subscriptions.filter(s => st.alerted_subs.includes(s.name) && s.events.includes('recovery'));
      } else {
        recipients = this.config.subscriptions.filter(s => this.matches(s, key, event, to, relevantNames));
      }
      const capped = st.day_count >= this.config.max_alerts_per_vendor_day;
      if (recipients.length && capped) {
        this.store.logAlert({ ts: now.toISOString(), vendor: key, event, from_status: from, to_status: to, suppressed: 'daily_cap', subscriptions: recipients.map(r => r.name) });
      } else if (recipients.length) {
        st.day_count += 1;
        const evt = this.buildEvent(event, service, from, to, now);
        for (const sub of recipients) {
          evt.subscription = sub.name;
          for (const channel of sub.channels) {
            const res = channel.type === 'email'
              ? await this.sendEmail(channel, buildEmail(channel, evt))
              : await this.send(channel, buildPayloads(channel, evt));
            this.store.logAlert({
              ts: now.toISOString(), vendor: key, event, from_status: from, to_status: to,
              subscription: sub.name, channel: channel.type, delivered: !!res.ok,
              error: res.ok ? undefined : res.error
            });
          }
        }
        fired.push({ event, from, to, subscriptions: recipients.map(r => r.name) });
        if (event === 'outage') {
          st.alerted_subs = [...new Set([...st.alerted_subs, ...recipients.map(r => r.name)])];
          st.peak_status = SEV[to] > SEV[st.peak_status || 'operational'] ? to : st.peak_status;
        } else if (event === 'recovery') {
          st.alerted_subs = []; st.peak_status = null;
        }
      }
    }
    this.store.saveAlertState(key, st);
    return fired;
  }

  buildEvent(event, service, from, to, now) {
    const components = service.components || [];
    const affected = components.filter(c => ['degraded', 'partial_outage', 'major_outage'].includes(c.status)).length;
    const active = (service.incidents || []).filter(i => !ACTIVE_EXCLUDE.includes(String(i.status).toLowerCase()));
    return {
      event,
      vendor_key: service.key,
      vendor_name: service.name,
      from_status: from,
      to_status: to,
      summary: service.overall_label || '',
      affected_functions: components.length ? affected : null,
      total_functions: components.length || null,
      affected_component_names: components.filter(c => ['degraded', 'partial_outage', 'major_outage'].includes(c.status)).map(c => c.name).slice(0, 50),
      maintenance_component_names: components.filter(c => c.status === 'maintenance').map(c => c.name).slice(0, 50),
      top_incident: active.length ? active[0].name : null,
      status_page_url: service.status_page_url,
      dashboard_url: this.config.dashboard_url || '',
      ts: now.toISOString()
    };
  }

  async sendTest(subscriptionName) {
    if (!this.config) return { ok: false, error: 'alerting disabled' };
    const sub = this.config.subscriptions.find(s => s.name === subscriptionName) ||
      (subscriptionName ? null : this.config.subscriptions[0]);
    if (!sub) return { ok: false, error: 'subscription not found: ' + subscriptionName };
    const evt = {
      event: 'test', vendor_key: 'test', vendor_name: 'SaaS Status',
      from_status: 'operational', to_status: 'operational',
      summary: 'Test alert from the SaaS Status dashboard — alerting is configured correctly.',
      affected_functions: null, total_functions: null, top_incident: null,
      status_page_url: 'https://status.slack.com', dashboard_url: this.config.dashboard_url || '',
      subscription: sub.name, ts: new Date().toISOString()
    };
    const results = [];
    for (const channel of sub.channels) {
      const res = channel.type === 'email'
        ? await this.sendEmail(channel, buildEmail(channel, evt))
        : await this.send(channel, buildPayloads(channel, evt));
      results.push({ channel: channel.type, ...res });
      this.store.logAlert({ ts: evt.ts, vendor: 'test', event: 'test', subscription: sub.name, channel: channel.type, delivered: !!res.ok, error: res.ok ? undefined : res.error });
    }
    return { ok: results.every(r => r.ok), subscription: sub.name, results };
  }
}

module.exports = { Alerter, loadAlertConfig, normalizeConfig, classifyTransition, buildPayloads, buildEmail, SEV, LABEL };
