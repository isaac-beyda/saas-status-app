/* Server-side vendor status parsers.
   Ported from the public static dashboard and hardened:
   - Overall status is DERIVED from live component states + active incidents.
     The feed's headline indicator is never trusted on its own (it once counted
     a future scheduled maintenance as a current Auth0 outage).
   - Future scheduled maintenance never affects current status.
   - Retired/deprecated components (Auth0 preview envs) are filtered out.
   Every parser returns: { status, summary, components[], incidents[], updatedAt, note }
   with the shared status vocabulary below. */
'use strict';

const S = {
  OK: 'operational',
  DEG: 'degraded',
  PART: 'partial_outage',
  MAJ: 'major_outage',
  MAINT: 'maintenance',
  UNK: 'unknown'
};

/* display/sort rank (problems float up) */
const RANK = { major_outage: 5, partial_outage: 4, degraded: 3, unknown: 2, maintenance: 1, operational: 0 };
/* severity rank used ONLY for status derivation; unknown carries no signal */
const SEV = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 };

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const i = cut.lastIndexOf(' ');
  return (i > n * 0.4 ? cut.slice(0, i) : cut) + '…';
}

/* freshness = newest activity, not a stale feed-level timestamp */
function freshest(r) {
  let best = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
  (r.incidents || []).forEach(i => {
    const t = i.created ? new Date(i.created).getTime() : 0;
    if (!isNaN(t) && t > best) best = t;
  });
  return best ? new Date(best).toISOString() : r.updatedAt;
}

/* ---------- status derivation (the global rule) ----------
   An incident contributes a floor only while it is ACTIVE:
   - resolved / completed / postmortem / scheduled (future) -> no contribution
   - in-progress maintenance -> maintenance
   - otherwise floor by impact: critical -> major, major -> partial, else degraded */
function incidentFloor(i) {
  const st = String(i.status || '').toLowerCase().replace(/_/g, ' ');
  if (/^(resolved|completed|postmortem|scheduled)$/.test(st)) return null;
  if (st === 'in progress' || st === 'verifying') return S.MAINT;
  switch (String(i.impact || '').toLowerCase()) {
    case 'critical': return S.MAJ;
    case 'major': return S.PART;
    default: return S.DEG;
  }
}

function deriveStatus(components, incidents) {
  let s = S.OK;
  for (const c of components || []) {
    const sev = SEV[c.status];
    if (sev != null && sev > SEV[s]) s = c.status;
  }
  for (const i of incidents || []) {
    const f = incidentFloor(i);
    if (f && SEV[f] > SEV[s]) s = f;
  }
  return s;
}

/* ---------- statuspage.io ---------- */
function mapSpComponent(status) {
  switch (status) {
    case 'operational': return S.OK;
    case 'degraded_performance': return S.DEG;
    case 'partial_outage': return S.PART;
    case 'major_outage': return S.MAJ;
    case 'under_maintenance': return S.MAINT;
    default: return S.UNK;
  }
}

function parseStatuspage(json, vendor) {
  const page = json.page || {}, st = json.status || {};
  const raw = (json.components || []).filter(c => c && c.name && !/^visit\s/i.test(c.name)); /* drop "Visit www.x" placeholders */
  const byId = new Map(raw.map(c => [c.id, c]));
  /* group containers are not functions — exclude them, but attach their
     names as the group label on their child components */
  const components = raw
    .filter(c => c.group !== true)
    .map(c => {
      const parent = c.group_id && byId.get(c.group_id);
      return { name: c.name, status: mapSpComponent(c.status), group: parent ? parent.name : undefined };
    });
  const incidents = (json.incidents || []).map(i => {
    const upd = (i.incident_updates || [])[0];
    return {
      title: i.name || 'Incident',
      status: (i.status || 'investigating').toLowerCase().replace(/_/g, ' '),
      impact: i.impact || '',
      url: i.shortlink || vendor.status_page_url,
      created: i.created_at || null,
      body: upd && upd.body ? trunc(stripHtml(upd.body), 600) : ''
    };
  });
  const maint = (json.scheduled_maintenances || []).map(m => ({
    title: m.name || 'Scheduled maintenance',
    status: (m.status || 'scheduled').toLowerCase().replace(/_/g, ' '),
    impact: 'maintenance',
    url: m.shortlink || vendor.status_page_url,
    created: m.scheduled_for || m.created_at || null,
    body: trunc(stripHtml(m.incident_updates && m.incident_updates[0] && m.incident_updates[0].body || ''), 600)
  }));
  const allIncidents = incidents.concat(maint);
  return {
    status: deriveStatus(components, allIncidents),
    summary: st.description || page.name || '',
    components,
    incidents: allIncidents,
    updatedAt: page.updated_at || null,
    note: ''
  };
}

/* ---------- Auth0 (statuspage minus deprecated environments) ----------
   Retired PREVIEW environments sit in a stale partial_outage state forever.
   They (and their child components) are excluded before deriving health. */
function isDeprecatedComponent(c, byId) {
  if (/deprecat/i.test(c.name || '')) return true;
  const g = c.group_id && byId.get(c.group_id);
  return !!(g && /deprecat/i.test(g.name || ''));
}

function parseAuth0(json, vendor) {
  const byId = new Map();
  (json.components || []).forEach(c => { if (c && c.id) byId.set(c.id, c); });
  const clean = {
    ...json,
    components: (json.components || []).filter(c => c && !isDeprecatedComponent(c, byId))
  };
  const r = parseStatuspage(clean, vendor);
  r.note = 'Deprecated preview environments are excluded from Auth0 health.';
  return r;
}

/* ---------- Slack (custom JSON: active incidents only) ---------- */
function parseSlack(json, vendor) {
  const active = json.active_incidents || [];
  return {
    status: active.length ? S.DEG : S.OK,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components: [],
    incidents: active.map(i => ({
      title: i.title || 'Slack incident',
      status: (i.type || 'investigating').toLowerCase(),
      impact: '',
      url: vendor.status_page_url,
      created: i.date_created || null,
      body: ''
    })),
    updatedAt: json.date_updated || null,
    note: "Slack's public API publishes active incidents only — no per-function breakdown is available."
  };
}

/* ---------- GitLab (status.io) ---------- */
function mapStatusIo(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('operation')) return S.OK;
  if (s.includes('degrad')) return S.DEG;
  if (s.includes('partial')) return S.PART;
  if (s.includes('major')) return S.MAJ;
  if (s.includes('maintenance')) return S.MAINT;
  return S.UNK;
}

function parseGitlab(json) {
  const r = json.result || {};
  const overall = r.status_overall || {};
  const components = [];
  (r.status || []).forEach(svc => {
    components.push({ name: svc.name || 'Service', status: mapStatusIo(svc.status) });
    (svc.containers || []).forEach(c => {
      components.push({ name: (svc.name || '') + ' › ' + (c.name || 'container'), status: mapStatusIo(c.status) });
    });
  });
  const toInc = (list, dflt) => (Array.isArray(list) ? list : []).map(i => ({
    title: i.name || i.title || 'Incident',
    status: (i.status || dflt).toLowerCase(),
    impact: '',
    url: 'https://status.gitlab.com',
    created: i.updated || i.created || null,
    body: trunc(stripHtml(i.message || i.body || ''), 600)
  }));
  const incidents = toInc(r.incidents, 'investigating').concat(toInc(r.maintenance, 'scheduled'));
  return {
    /* status.io's overall reflects live component states; keep it, but never
       let a scheduled maintenance entry raise it */
    status: deriveStatus(components, incidents.filter(i => incidentFloor(i))),
    summary: overall.status || '',
    components,
    incidents,
    updatedAt: overall.updated || null,
    note: ''
  };
}

/* ---------- DocuSign (custom incidents JSON) ---------- */
function mapDsImpact(impact) {
  switch (String(impact || '').toLowerCase()) {
    case 'available': return S.OK;
    case 'performance_degradation': return S.DEG;
    case 'service_disruption': return S.MAJ;
    default: return S.UNK;
  }
}

function parseDocusign(json, vendor) {
  const all = json.incidents || [];
  const active = all.filter(i => !['resolved', 'closed'].includes(String(i.status || '').toLowerCase()));
  const compMap = new Map();
  all.forEach(i => (i.components || []).forEach(c => {
    if (c && c.name && !compMap.has(c.name)) compMap.set(c.name, mapDsImpact(c.status));
  }));
  let status = S.OK;
  active.forEach(i => {
    const s = mapDsImpact(i.impact);
    if (SEV[s] != null && SEV[s] > SEV[status]) status = s;
  });
  return {
    status,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components: [...compMap.entries()].map(([name, st]) => ({ name, status: st })),
    incidents: all.slice(0, 12).map(i => {
      const ev = (i.events || [])[0];
      return {
        title: i.title || 'Incident',
        status: String(i.status || 'investigating').toLowerCase(),
        impact: i.impact || '',
        url: vendor.status_page_url,
        created: i.startedAt || i.createdAt || null,
        body: ev && ev.body ? trunc(stripHtml(ev.body), 600) : ''
      };
    }),
    updatedAt: (all[0] && all[0].updatedAt) || null,
    note: ''
  };
}

/* ---------- Google Workspace (incidents + products) ---------- */
function parseGoogleWorkspace(incJson, prodJson) {
  const now = Date.now();
  const incidents = Array.isArray(incJson) ? incJson : [];
  const products = (prodJson && prodJson.products) || [];
  const active = incidents.filter(i => !i.end || new Date(i.end).getTime() > now);
  const affected = new Set();
  active.forEach(i => (i.affected_products || []).forEach(p => p && p.id && affected.add(p.id)));
  let components, note = '';
  if (products.length) {
    components = products.map(p => ({ name: p.title || p.id, status: affected.has(p.id) ? S.DEG : S.OK }));
  } else {
    const seen = new Map();
    incidents.forEach(i => (i.affected_products || []).forEach(p => {
      if (p && p.id && !seen.has(p.id)) seen.set(p.id, p.title || p.id);
    }));
    components = [...seen.entries()].map(([id, name]) => ({ name, status: affected.has(id) ? S.DEG : S.OK }));
    note = 'Full product catalog unavailable — showing products seen in recent incidents.';
  }
  const gwUrl = (u) => !u ? 'https://www.google.com/appsstatus/dashboard/'
    : (String(u).startsWith('http') ? u : 'https://www.google.com/appsstatus/dashboard/' + u);
  return {
    status: active.length ? S.DEG : S.OK,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components,
    incidents: incidents.slice(0, 12).map(i => ({
      title: (i.service_name || 'Google Workspace') + ' — ' + (i.status_impact || i.severity || 'incident'),
      status: (!i.end || new Date(i.end).getTime() > now) ? 'investigating' : 'resolved',
      impact: '',
      url: gwUrl(i.uri),
      created: i.begin || i.created || null,
      body: trunc(stripHtml(i.external_desc || '').replace(/\*\*/g, ''), 600)
    })),
    updatedAt: (incidents[0] && incidents[0].modified) || null,
    note
  };
}

/* ---------- Salesforce (incidents + products APIs) ----------
   Product health comes from the products API counts (incidentCount /
   maintenanceCount) — the incidents API alone misses planned maintenance
   (e.g. Salesforce Services + Spiff sat in maintenance with 0 incidents). */
function parseSalesforce(incJson, prodJson) {
  const incidents = Array.isArray(incJson) ? incJson : [];
  const products = Array.isArray(prodJson) ? prodJson.filter(p => p.isActive) : [];
  const active = incidents.filter(i => i.status === 'Active');
  const affected = new Set();
  active.forEach(i => (i.serviceKeys || []).forEach(k => affected.add(String(k).toLowerCase())));
  const components = products.map(p => {
    const key = String(p.key || '').toLowerCase();
    let st = S.OK;
    if (affected.has(key) || (p.incidentCount || 0) > 0) st = S.DEG;
    else if ((p.maintenanceCount || 0) > 0) st = S.MAINT;
    return { name: p.altDisplayName || p.name || p.key, status: st };
  });
  const status = deriveStatus(components, active.map(i => ({ status: 'investigating', impact: '' })));
  const activeFirst = active.concat(incidents.filter(i => i.status !== 'Active')).slice(0, 12);
  return {
    status,
    summary: active.length ? active.length + ' active incident(s)' : 'All systems operational',
    components,
    incidents: activeFirst.map(i => {
      const tl = (i.timeline || [])[0];
      return {
        title: (i.type || 'Incident') + ' — ' + (i.serviceKeys || []).join(', '),
        status: i.status === 'Active' ? 'investigating' : 'resolved',
        impact: '',
        url: 'https://status.salesforce.com',
        created: i.createdAt || null,
        body: trunc(stripHtml((tl && tl.content) ? tl.content : (i.additionalInformation || '')), 600)
      };
    }),
    updatedAt: (incidents[0] && incidents[0].updatedAt) || null,
    note: ''
  };
}

/* ---------- RSS (regex-based; no DOM on the server) ---------- */
function rssItems(text) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = m[1];
    const q = (tag) => {
      const mm = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(block);
      if (!mm) return '';
      return mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    };
    items.push({ title: q('title'), link: q('link'), pubDate: q('pubDate'), guid: q('guid'), desc: q('description') });
  }
  if (!items.length && /<rss|<feed/i.test(text)) return items;
  if (!items.length) throw new Error('bad rss');
  return items;
}

/* AWS fallback (RSS headline feed) — used only if the health API is down */
function parseAWS(text) {
  const items = rssItems(text);
  const dayMs = 24 * 3600 * 1000;
  const alarming = /disruption|degradation|impairment|outage|increased error|elevated/i;
  const resolved = /resolv|restored|recovered|complete|all clear/i;
  let latest = 0;
  items.forEach(i => { const t = new Date(i.pubDate).getTime(); if (!isNaN(t) && t > latest) latest = t; });
  const cutoff = latest ? Math.min(Date.now(), latest) - dayMs : Date.now() - dayMs;
  const recent = items.filter(i => { const t = new Date(i.pubDate).getTime(); return !isNaN(t) && t >= cutoff; });
  const bad = recent.filter(i => alarming.test(i.title) && !resolved.test(i.title));
  return {
    status: bad.length ? S.DEG : S.OK,
    summary: bad.length ? bad.length + ' recent service event(s)' : 'No recent service events',
    components: [],
    incidents: items.slice(0, 12).map(i => ({
      title: stripHtml(i.title),
      status: alarming.test(i.title) && !resolved.test(i.title) ? 'monitoring' : 'resolved',
      impact: '',
      url: 'https://status.aws.amazon.com/',
      created: i.pubDate || null,
      body: trunc(stripHtml(i.desc), 600)
    })),
    updatedAt: (items[0] && items[0].pubDate) || null,
    note: 'AWS health API unreachable — status inferred from the latest published RSS events.'
  };
}

/* AWS primary: public health events API (JSON).
   The endpoint lists OPEN events only. AWS publishes no full service catalog,
   so components = services/regions with open events (partial outage). */
function parseAwsHealth(json) {
  const events = Array.isArray(json) ? json : [];
  const compMap = new Map();
  events.forEach(e => {
    const region = e.region_name || '';
    /* impacted_services: { "<service>-<region>": { service_name, current, max } }
       — the per-service detail behind the region-level event. The status
       codes are undocumented; in open disruption events they denote
       region-availability impact, surfaced here as partial outage. */
    const impacted = e.impacted_services || {};
    const entries = Object.entries(impacted);
    if (entries.length) {
      entries.forEach(([id, info]) => {
        if (!compMap.has(id)) {
          compMap.set(id, { name: (info && info.service_name) || id, status: S.PART, group: region || undefined });
        }
      });
    } else {
      const name = e.service_name || e.service || 'Multiple services';
      const key = name + '|' + region;
      if (!compMap.has(key)) compMap.set(key, { name, status: S.PART, group: region || undefined });
    }
  });
  const ts = (e) => {
    const d = Number(e.date);
    return isFinite(d) && d > 0 ? new Date(d * 1000).toISOString() : null;
  };
  return {
    status: events.length ? S.PART : S.OK,
    summary: events.length ? events.length + ' open event(s)' : 'No open events',
    components: [...compMap.values()],
    incidents: events.map(e => ({
      title: (e.service_name || e.service || 'AWS event') + ': Region Availability',
      status: 'open',
      impact: 'Partial outage' + (e.region_name ? ' · ' + e.region_name : ''),
      url: 'https://health.aws.amazon.com/health/status',
      created: ts(e),
      body: trunc(stripHtml(e.summary || ''), 600)
    })),
    updatedAt: events.map(ts).filter(Boolean).sort().pop() || null,
    note: 'AWS publishes open health events only — no full service catalog. Status reflects regions/services with open events.'
  };
}

/* ---------- incident.io RSS (Docker, Intercom) ---------- */
function parseIncidentIoRss(text, vendor) {
  const items = rssItems(text);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const open = items.filter(i => {
    const t = new Date(i.pubDate).getTime();
    return !isNaN(t) && t > weekAgo && !/complete|resolved/i.test(i.desc.slice(0, 300));
  });
  return {
    status: open.length ? S.DEG : S.OK,
    summary: open.length ? open.length + ' recent update(s)' : 'No recent incidents reported',
    components: [],
    incidents: items.slice(0, 12).map(i => ({
      title: stripHtml(i.title),
      status: /maintenance/i.test(i.title) ? 'scheduled'
        : (/complete|resolved/i.test(i.desc.slice(0, 300)) ? 'resolved' : 'monitoring'),
      impact: '',
      url: i.link || vendor.status_page_url,
      created: i.pubDate || null,
      body: trunc(stripHtml(i.desc), 600)
    })),
    updatedAt: (items[0] && items[0].pubDate) || null,
    note: 'Component-level data is not published by this feed — incident history only.'
  };
}

/* ---------- Microsoft (status.cloud.microsoft posts + service catalog) ----------
   Microsoft publishes advisory posts, not a component API. The catalog below
   is the M365/Azure/Dynamics service list; services named in an active post
   are marked degraded. This is a provider-level signal — see the note. */
const MS_CATALOG = require('./ms-catalog');

function parseMicrosoft(posts, vendor) {
  /* posts: array of post objects from /api/posts/<service> (single object ok) */
  const list = (Array.isArray(posts) ? posts : [posts]).filter(p => p && typeof p === 'object');
  const active = list.filter(p => {
    const st = String(p.Status || '').toLowerCase();
    return st && !/available|resolved|restored|no .* issues/i.test(st);
  });
  const incidents = active.map(p => ({
    title: p.Title || 'Microsoft service advisory',
    status: String(p.Status || 'Service degradation'),
    impact: /interrupt|outage/i.test(String(p.Status || '')) ? 'major' : '',
    url: vendor.status_page_url,
    created: p.AuthoredDateTime || p.LastUpdatedTime || null,
    body: trunc(stripHtml(p.Message || ''), 600)
  }));
  const haystack = active.map(p => (p.Title || '') + ' ' + (p.Message || '')).join(' ').toLowerCase();
  const components = MS_CATALOG.map(c => {
    const hit = haystack && (haystack.includes(c.name.toLowerCase()) ||
      c.aliases.some(a => haystack.includes(a)));
    return { name: c.name, status: hit ? S.DEG : S.OK, group: c.group };
  });
  let status = S.OK;
  if (active.length) {
    status = active.some(p => /interrupt|outage/i.test(String(p.Status || ''))) ? S.PART : S.DEG;
    /* if no catalog service matched by name, fall back to the post's own signal */
  }
  return {
    status,
    summary: active.length ? active.length + ' active advisor' + (active.length === 1 ? 'y' : 'ies') : 'No issues detected',
    components,
    incidents,
    updatedAt: (list[0] && (list[0].LastUpdatedTime || list[0].AuthoredDateTime)) || null,
    note: 'Microsoft publishes status as advisory posts — affected services are matched from post text (provider-level signal).'
  };
}

/* ---------- Zendesk (SSP incidents API, JSON:API shape) ---------- */
function parseZendeskSsp(json, vendor) {
  const data = Array.isArray(json.data) ? json.data : [];
  const included = Array.isArray(json.included) ? json.included : [];
  const incServices = included.filter(x => x && x.type === 'incidentService');
  const svcStatus = new Map();
  incServices.forEach(x => {
    const a = x.attributes || {};
    if (!a.serviceName) return;
    let st = S.OK;
    if (!a.resolvedAt) st = a.outage ? S.MAJ : (a.degradation ? S.DEG : S.OK);
    const cur = svcStatus.get(a.serviceName);
    if (cur == null || (SEV[st] || 0) > (SEV[cur] || 0)) svcStatus.set(a.serviceName, st);
  });
  const incidents = data
    .filter(i => !(i.attributes || {}).resolvedAt)
    .map(i => {
      const a = i.attributes || {};
      return {
        title: a.name || 'Incident',
        status: String(a.status || 'investigating').toLowerCase(),
        impact: a.impact || '',
        url: vendor.status_page_url,
        created: a.startedAt || null,
        body: ''
      };
    });
  const components = [...svcStatus.entries()].map(([name, status]) => ({ name, status }));
  return {
    status: deriveStatus(components, incidents),
    summary: incidents.length ? incidents.length + ' active incident(s)' : 'All systems operational',
    components,
    incidents,
    updatedAt: (incidents[0] && incidents[0].created) || null,
    note: 'Service list derived from services referenced by recent incidents.'
  };
}

/* ---------- PagerDuty (status.pagerduty.com /api) ----------
   /api/services = catalog; /api/impacted_services = live impact list;
   /api/data layout carries the global headline as a cross-check. */
function parsePagerduty(servicesJson, impactedJson, vendor) {
  const catalog = (servicesJson && servicesJson.services) || [];
  const impacted = (impactedJson && impactedJson.impacted_services) || [];
  const impactById = new Map();
  const impactByName = new Map();
  impacted.forEach(s => {
    const raw = String(s.status || s.impact || 'degraded').toLowerCase();
    const st = /partial/.test(raw) ? S.PART : (/outage|major/.test(raw) ? S.MAJ : S.DEG);
    if (s.id) impactById.set(String(s.id), st);
    if (s.name) impactByName.set(String(s.name), st);
  });
  const components = catalog
    .filter(s => s && s.is_active !== false && (s.display_name || s.name))
    .map(s => ({
      name: s.display_name || s.name,
      status: impactById.get(String(s.id)) || impactByName.get(String(s.name)) || S.OK
    }));
  const incidents = impacted.map(s => ({
    title: s.incident_title || s.title || ('Impact: ' + (s.name || 'service')),
    status: 'investigating',
    impact: String(s.status || s.impact || ''),
    url: vendor.status_page_url,
    created: s.created_at || s.started_at || null,
    body: trunc(stripHtml(s.description || ''), 600)
  }));
  return {
    status: deriveStatus(components, incidents.map(i => ({ status: i.status, impact: i.impact }))),
    summary: impacted.length ? impacted.length + ' impacted service(s)' : 'Everything is running smoothly',
    components,
    incidents,
    updatedAt: null,
    note: 'Component statuses come from PagerDuty’s impacted-services feed.'
  };
}

/* ---------- fetching / dispatch ---------- */
async function fetchWithTimeout(fetchFn, url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetchFn(url, { signal: c.signal, headers: { 'user-agent': 'saas-status-app/1.0', 'accept': 'application/json, text/plain, */*' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  } finally {
    clearTimeout(t);
  }
}

/* Some official feeds serve JSON in UTF-16 (AWS Health API:
   content-type application/json;charset=utf-16). Decode by the declared
   charset, sniffing the BOM when none is declared. */
async function decodeJson(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  const declared = ((ct.match(/charset=([^;]+)/i) || [])[1] || '').trim().toLowerCase().replace(/["']/g, '');
  const text = new TextDecoder(pickCharset(buf, declared)).decode(buf);
  return JSON.parse(text.replace(/^[\ufeff\ufffe]/, ''));
}

/* AWS Health declares just "utf-16" — endianness comes from the BOM
   (FE FF = big-endian, FF FE = little-endian). TextDecoder also rejects the
   bare "utf-16" label, so always resolve to an explicit endianness. */
function pickCharset(buf, declared) {
  const bomBE = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
  const bomLE = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  if (!declared || declared === 'utf-16' || declared === 'unicode' || declared === 'ucs-2') {
    if (bomBE) return 'utf-16be';
    if (bomLE) return 'utf-16le';
    return declared ? 'utf-16le' : 'utf-8';
  }
  return declared;
}

async function fetchVendor(vendor, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const timeout = opts.timeoutMs || 20000;
  const getJson = async (url) => decodeJson(await fetchWithTimeout(fetchFn, url, timeout));
  const getText = async (url) => {
    const res = await fetchWithTimeout(fetchFn, url, timeout);
    return res.text();
  };
  let r;
  switch (vendor.key) {
    case 'slack': r = parseSlack(await getJson(vendor.source_url), vendor); break;
    case 'gitlab': r = parseGitlab(await getJson(vendor.source_url)); break;
    case 'docusign': r = parseDocusign(await getJson(vendor.source_url), vendor); break;
    case 'google-workspace': {
      const [inc, prod] = await Promise.all([
        getJson(vendor.source_url),
        getJson('https://www.google.com/appsstatus/dashboard/products.json').catch(() => null)
      ]);
      r = parseGoogleWorkspace(inc, prod);
      break;
    }
    case 'salesforce': {
      const [inc, prod] = await Promise.all([
        getJson(vendor.source_url),
        getJson('https://api.status.salesforce.com/v1/products')
      ]);
      r = parseSalesforce(inc, prod);
      break;
    }
    case 'aws': {
      try {
        r = parseAwsHealth(await getJson(vendor.source_url));
      } catch (e) {
        if (!vendor.fallback_url) throw e;
        r = parseAWS(await getText(vendor.fallback_url));
      }
      break;
    }
    case 'auth0': r = parseAuth0(await getJson(vendor.source_url), vendor); break;
    case 'docker':
    case 'intercom': r = parseIncidentIoRss(await getText(vendor.source_url), vendor); break;
    case 'microsoft': {
      const posts = await getJson(vendor.source_url).catch(() => null);
      r = parseMicrosoft(posts == null ? [] : posts, vendor);
      break;
    }
    case 'zendesk': r = parseZendeskSsp(await getJson(vendor.source_url), vendor); break;
    case 'pagerduty': {
      const origin = new URL(vendor.status_page_url).origin;
      const [svc, imp] = await Promise.all([
        getJson(origin + '/api/services'),
        getJson(origin + '/api/impacted_services').catch(() => ({ impacted_services: [] }))
      ]);
      r = parsePagerduty(svc, imp, vendor);
      break;
    }
    default: r = parseStatuspage(await getJson(vendor.source_url), vendor);
  }
  r.updatedAt = freshest(r);
  return r;
}

module.exports = {
  S, RANK, SEV,
  stripHtml, trunc, freshest,
  incidentFloor, deriveStatus,
  mapSpComponent, parseStatuspage, parseAuth0, isDeprecatedComponent,
  parseSlack, parseGitlab, parseDocusign, parseGoogleWorkspace, parseSalesforce,
  rssItems, parseAWS, parseAwsHealth, parseIncidentIoRss,
  parseMicrosoft, parseZendeskSsp, parsePagerduty,
  fetchVendor
};
