/* Parser tests — synthetic fixtures for the tricky vendors and the global
   derivation rules. Run: npm test (node --test). No network needed except
   where a stub fetch is injected. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../server/parsers');

const V = { key: 'x', name: 'X', status_page_url: 'https://status.example.com' };

/* ---------- derivation rules ---------- */
test('deriveStatus: worst component wins', () => {
  assert.equal(P.deriveStatus([{ status: 'operational' }, { status: 'degraded' }], []), 'degraded');
  assert.equal(P.deriveStatus([{ status: 'partial_outage' }], []), 'partial_outage');
  assert.equal(P.deriveStatus([], []), 'operational');
});

test('deriveStatus: unknown components carry no signal', () => {
  assert.equal(P.deriveStatus([{ status: 'unknown' }], []), 'operational');
});

test('incidentFloor: scheduled and resolved never contribute', () => {
  assert.equal(P.incidentFloor({ status: 'scheduled', impact: 'major' }), null);
  assert.equal(P.incidentFloor({ status: 'resolved', impact: 'critical' }), null);
  assert.equal(P.incidentFloor({ status: 'completed', impact: 'major' }), null);
});

test('incidentFloor: in-progress maintenance floors to maintenance', () => {
  assert.equal(P.incidentFloor({ status: 'in_progress', impact: 'maintenance' }), 'maintenance');
  assert.equal(P.incidentFloor({ status: 'in progress', impact: '' }), 'maintenance');
});

test('incidentFloor: active incidents floor by impact', () => {
  assert.equal(P.incidentFloor({ status: 'investigating', impact: 'minor' }), 'degraded');
  assert.equal(P.incidentFloor({ status: 'identified', impact: 'major' }), 'partial_outage');
  assert.equal(P.incidentFloor({ status: 'monitoring', impact: 'critical' }), 'major_outage');
  assert.equal(P.incidentFloor({ status: 'investigating', impact: '' }), 'degraded');
});

/* ---------- statuspage: the Oct 20 Auth0 regression ---------- */
test('statuspage: future scheduled maintenance does NOT degrade current status', () => {
  const feed = {
    page: { updated_at: '2026-10-20T00:00:00Z' },
    status: { indicator: 'maintenance', description: 'Scheduled maintenance' },
    components: [{ id: 'a', name: 'API', status: 'operational', group: false }],
    incidents: [],
    scheduled_maintenances: [{
      name: 'Planned Maintenance', status: 'scheduled',
      scheduled_for: '2026-10-28T01:00:00Z', incident_updates: [{ body: 'no impact expected' }]
    }]
  };
  const r = P.parseStatuspage(feed, V);
  assert.equal(r.status, 'operational');
  assert.equal(r.incidents.length, 1);
  assert.equal(r.incidents[0].status, 'scheduled');
});

test('statuspage: in-progress maintenance yields maintenance status', () => {
  const feed = {
    page: {}, status: { indicator: 'maintenance' },
    components: [{ id: 'a', name: 'API', status: 'under_maintenance', group: false }],
    incidents: [],
    scheduled_maintenances: [{ name: 'Upgrade', status: 'in_progress', scheduled_for: '2026-10-20T00:00:00Z', incident_updates: [] }]
  };
  assert.equal(P.parseStatuspage(feed, V).status, 'maintenance');
});

test('statuspage: group containers excluded, names become group labels', () => {
  const feed = {
    page: {}, status: { indicator: 'none' },
    components: [
      { id: 'g1', name: 'US Region', status: 'operational', group: true },
      { id: 'c1', name: 'Sign in', status: 'operational', group: false, group_id: 'g1' },
      { id: 'c2', name: 'API', status: 'degraded_performance', group: false }
    ],
    incidents: [], scheduled_maintenances: []
  };
  const r = P.parseStatuspage(feed, V);
  assert.equal(r.components.length, 2);
  assert.equal(r.components[0].group, 'US Region');
  assert.equal(r.status, 'degraded');
});

/* ---------- Auth0 deprecated filtering ---------- */
test('auth0: deprecated environments and their children are excluded', () => {
  const feed = {
    page: {}, status: { indicator: 'minor' },
    components: [
      { id: 'g1', name: 'US-3 (PREVIEW) DEPRECATED', status: 'partial_outage', group: true },
      { id: 'c1', name: 'User Authentication', status: 'partial_outage', group: false, group_id: 'g1' },
      { id: 'c2', name: 'User Authentication', status: 'operational', group: false },
      { id: 'c3', name: 'Legacy DEPRECATED thing', status: 'major_outage', group: false }
    ],
    incidents: [], scheduled_maintenances: []
  };
  const r = P.parseAuth0(feed, V);
  assert.equal(r.components.length, 1);
  assert.equal(r.status, 'operational');
});

/* ---------- Slack ---------- */
test('slack: active incidents degrade, none means operational', () => {
  assert.equal(P.parseSlack({ active_incidents: [{ title: 'Outage', type: 'incident', date_created: '2026-01-01T00:00:00Z' }] }, V).status, 'degraded');
  assert.equal(P.parseSlack({ active_incidents: [] }, V).status, 'operational');
});

/* ---------- Salesforce: product counts carry maintenance ---------- */
test('salesforce: maintenanceCount marks product + vendor as maintenance', () => {
  const products = [{ key: 'core', name: 'Salesforce Services', isActive: true, incidentCount: 0, maintenanceCount: 1 }];
  const r = P.parseSalesforce([], products);
  assert.equal(r.components[0].status, 'maintenance');
  assert.equal(r.status, 'maintenance');
});

test('salesforce: incidentCount degrades; quiet products stay operational', () => {
  const products = [
    { key: 'a', name: 'A', isActive: true, incidentCount: 1, maintenanceCount: 0 },
    { key: 'b', name: 'B', isActive: true, incidentCount: 0, maintenanceCount: 0 },
    { key: 'c', name: 'C', isActive: false, incidentCount: 1, maintenanceCount: 0 }
  ];
  const r = P.parseSalesforce([], products);
  assert.equal(r.components.length, 2); /* inactive product excluded */
  assert.equal(r.status, 'degraded');
});

/* ---------- AWS health API ---------- */
test('aws health: impacted_services expand to partial components', () => {
  const payload = [{
    service_name: 'Multiple services', region_name: 'UAE', date: '1789483629', summary: 'disruption',
    impacted_services: {
      's3-me-central-1': { service_name: 'Amazon S3', current: '3', max: '3' },
      'rds-me-central-1': { service_name: 'Amazon RDS', current: '3', max: '3' }
    }
  }];
  const r = P.parseAwsHealth(payload);
  assert.equal(r.status, 'partial_outage');
  assert.equal(r.components.length, 2);
  assert.equal(r.components[0].group, 'UAE');
  assert.equal(P.parseAwsHealth([]).status, 'operational');
});

test('aws via fetchVendor: UTF-16BE JSON decodes (AWS serves charset=utf-16)', async () => {
  const payload = JSON.stringify([{ service_name: 'Multiple services', region_name: 'UAE', date: '1789483629', summary: 'x', impacted_services: {} }]);
  const utf16be = Buffer.from('﻿' + payload, 'utf16le').swap16(); /* BOM + BE body */
  const stubFetch = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => h === 'content-type' ? 'application/json;charset=utf-16' : null },
    arrayBuffer: async () => utf16be.buffer.slice(utf16be.byteOffset, utf16be.byteOffset + utf16be.byteLength),
    text: async () => { throw new Error('not used'); }
  });
  const vendors = require('../server/vendors.json');
  const aws = vendors.find(v => v.key === 'aws');
  const r = await P.fetchVendor(aws, { fetch: stubFetch, timeoutMs: 5000 });
  assert.equal(r.status, 'partial_outage');
  assert.equal(r.incidents.length, 1);
});

/* ---------- Google Workspace ---------- */
test('google: product in an active incident is degraded', () => {
  const inc = [{ service_name: 'Gmail', status_impact: 'Outage', begin: '2026-01-01T00:00:00Z', end: null, affected_products: [{ id: 'gmail', title: 'Gmail' }], external_desc: 'down' }];
  const prod = { products: [{ id: 'gmail', title: 'Gmail' }, { id: 'drive', title: 'Drive' }] };
  const r = P.parseGoogleWorkspace(inc, prod);
  assert.equal(r.status, 'degraded');
  assert.equal(r.components.find(c => c.name === 'Drive').status, 'operational');
  assert.equal(r.components.find(c => c.name === 'Gmail').status, 'degraded');
});

/* ---------- Zendesk SSP ---------- */
test('zendesk: unresolved degraded service marks component + vendor', () => {
  const payload = {
    data: [{ id: '1', type: 'incident', attributes: { name: 'EU delays', status: 'identified', impact: 'minor', startedAt: '2026-01-01T00:00:00Z', resolvedAt: null } }],
    included: [
      { type: 'incidentService', attributes: { serviceName: 'AI Agents', degradation: true, outage: false, resolvedAt: null } },
      { type: 'incidentService', attributes: { serviceName: 'Chat', degradation: false, outage: false, resolvedAt: '2026-01-01T01:00:00Z' } }
    ]
  };
  const r = P.parseZendeskSsp(payload, V);
  assert.equal(r.components.find(c => c.name === 'AI Agents').status, 'degraded');
  assert.equal(r.components.find(c => c.name === 'Chat').status, 'operational');
  assert.equal(r.status, 'degraded');
});

/* ---------- PagerDuty ---------- */
test('pagerduty: impacted services degrade; empty impact means operational', () => {
  const catalog = { services: [{ id: '1', name: 'Events API', display_name: 'Events API', is_active: true }, { id: '2', name: 'Webhooks', display_name: 'Webhooks', is_active: true }] };
  const ok = P.parsePagerduty(catalog, { impacted_services: [] }, V);
  assert.equal(ok.status, 'operational');
  const bad = P.parsePagerduty(catalog, { impacted_services: [{ id: '1', name: 'Events API', status: 'partial_outage' }] }, V);
  assert.equal(bad.components.find(c => c.name === 'Events API').status, 'partial_outage');
  assert.equal(bad.status, 'partial_outage');
});

/* ---------- Microsoft posts ---------- */
test('microsoft: Available post means operational; degradation post marks named services', () => {
  const fine = P.parseMicrosoft({ Status: 'Available', Message: 'No Azure issues detected at this time.' }, V);
  assert.equal(fine.status, 'operational');
  const bad = P.parseMicrosoft({ Status: 'Service degradation', Title: 'Outlook issues', Message: 'Users may be unable to access Outlook or OneDrive.', AuthoredDateTime: '2026-01-01T00:00:00Z' }, V);
  assert.equal(bad.status, 'degraded');
  const outlook = bad.components.filter(c => /outlook/i.test(c.name));
  assert.ok(outlook.length >= 2 && outlook.every(c => c.status === 'degraded'));
  assert.equal(bad.components.find(c => c.name === 'Azure Functions').status, 'operational');
});

/* ---------- RSS helpers ---------- */
test('rss: items parse and AWS fallback reads alarming headlines', () => {
  const xml = '<?xml version="1.0"?><rss><channel>' +
    '<item><title>Amazon EC2 disruption in us-east-1</title><link>https://x</link><pubDate>' + new Date().toUTCString() + '</pubDate><description>bad</description></item>' +
    '<item><title>Old resolved event</title><link>https://x</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>ok</description></item>' +
    '</channel></rss>';
  const items = P.rssItems(xml);
  assert.equal(items.length, 2);
  const r = P.parseAWS(xml);
  assert.equal(r.status, 'degraded');
});
