/* SaaS Status — internal console frontend.
   Data comes from the backend aggregator (/api/statuses + /api/health):
   the server polls every vendor's official feed, so all viewers share one
   cached, consistent view. Favorites (max 10) are pinned to the top and
   stored in this browser's localStorage. */
'use strict';

const S = {
  OK: 'operational', DEG: 'degraded', PART: 'partial_outage',
  MAJ: 'major_outage', MAINT: 'maintenance', UNK: 'unknown'
};
const STATUS_LABEL = {
  operational: 'Operational', degraded: 'Degraded', partial_outage: 'Partial outage',
  major_outage: 'Major outage', maintenance: 'Maintenance', unknown: 'Unknown'
};
const RANK = { major_outage: 5, partial_outage: 4, degraded: 3, unknown: 2, maintenance: 1, operational: 0 };
const ACTIVE_EXCLUDE = ['resolved', 'completed', 'scheduled', 'postmortem'];

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) {
    const mins = Math.round(-diff / 60000);
    if (mins < 60) return 'in ' + mins + ' min';
    const h = Math.round(mins / 60);
    if (h < 48) return 'in ' + h + ' hr';
    return 'in ' + Math.round(h / 24) + 'd';
  }
  const mins = Math.max(0, Math.round(diff / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' hr ago';
  return Math.round(h / 24) + 'd ago';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString();
}

function pluralWord(n, one, many) { return (n === 1 ? one : many); }

/* ---------- state ---------- */
let SERVICES = [];            /* API service objects */
let HEALTH = {};              /* key -> feed health */
let lastRefreshed = null;
const OPEN = new Set();       /* expanded detail sections, preserved across renders */
let firstPaintDone = false;

/* ---------- favorites (top 10, pinned, browser-persisted) ---------- */
const FAV_KEY = 'ssa-favorites-v1';
const MAX_FAVS = 10;
let FAVS = loadFavs();

function loadFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, MAX_FAVS) : [];
  } catch (e) { return []; }
}
function saveFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(FAVS)); } catch (e) { /* private mode */ }
}
function toggleFav(key) {
  const i = FAVS.indexOf(key);
  if (i >= 0) { FAVS.splice(i, 1); saveFavs(); render(); return; }
  if (FAVS.length >= MAX_FAVS) { showToast('Favorites are capped at 10 — unstar one to make room.'); return; }
  FAVS.push(key); saveFavs(); render();
}

/* ---------- view model ----------
   Adapt the API shape to the card renderer. Freshness = newest incident
   activity; feed problems come from /api/health, not the status payload. */
function vm(svc) {
  const incidents = (svc.incidents || []).map(i => ({
    title: i.name, status: i.status, impact: i.impact || '',
    url: i.url, created: i.updated_at, body: i.description || ''
  }));
  let freshestTs = 0;
  incidents.forEach(i => {
    const t = i.created ? new Date(i.created).getTime() : 0;
    if (!isNaN(t) && t > freshestTs) freshestTs = t;
  });
  const h = HEALTH[svc.key] || {};
  let feedNote = '';
  if (h.consecutive_failures > 0) {
    feedNote = 'Feed unreachable (last error: ' + (h.last_error || 'unknown') + ') — showing last known status from ' +
      timeAgo(h.last_success_at) + '.';
  } else if (h.shape_warning) {
    feedNote = 'Feed shape changed — it suddenly reports 0 functions. Parser may need attention; see /api/health.';
  }
  return {
    status: svc.overall_status,
    summary: svc.overall_label,
    components: svc.components || [],
    incidents,
    updatedAt: freshestTs ? new Date(freshestTs).toISOString() : null,
    note: svc.note || '',
    feedNote
  };
}

/* ---------- rendering ---------- */
function pillClass(s) { return 'pill pill-' + s; }
function dotClass(s) { return 'dot dot-' + s; }
function chipClass(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const known = ['investigating', 'identified', 'monitoring', 'degraded', 'resolved', 'completed', 'operational', 'scheduled', 'maintenance', 'open'];
  return 'chip chip-' + (known.includes(k) ? k : 'default');
}

function logoHtml(svc) {
  if (svc.logo) {
    return '<img src="' + esc(svc.logo) + '" alt="' + esc(svc.name) + ' logo" loading="lazy" onerror="this.parentNode.innerHTML=\'<div class=&quot;logo-fallback&quot;&gt;' + esc(svc.name.charAt(0)) + '</div>\'">';
  }
  return '<div class="logo-fallback">' + esc(svc.name.charAt(0)) + '</div>';
}

function incidentRow(i) {
  const title = i.url
    ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.title) + '</a>'
    : esc(i.title);
  return '<div class="incident-row">' +
    '<div class="incident-top"><span class="incident-title">' + title + '</span>' +
    '<span class="' + chipClass(i.status) + '">' + esc(i.status || 'update') + '</span></div>' +
    '<div class="incident-meta"><span>' + esc(timeAgo(i.created)) + '</span>' +
    (i.created ? '<span class="mono" title="' + esc(fmtTime(i.created)) + '">' + esc(fmtTime(i.created)) + '</span>' : '') + '</div>' +
    (i.body ? '<p class="incident-body">' + esc(i.body) + '</p>' : '') +
    '</div>';
}

function detailsToggle(key, kind, label, n) {
  const id = kind + '-' + key;
  const open = OPEN.has(id);
  return '<button class="details-toggle" type="button" aria-expanded="' + open + '" data-target="' + esc(id) + '"><span>' +
    esc(label) + ' (' + n + ')</span><span class="chev">▾</span></button>';
}

function cardHtml(svc) {
  const r = vm(svc);
  /* "Affected" counts degraded/partial/major ONLY — functions in scheduled or
     in-progress maintenance are reported separately, never as breakage. */
  const affected = r.components.filter(c => [S.DEG, S.PART, S.MAJ].includes(c.status)).length;
  const inMaint = r.components.filter(c => c.status === S.MAINT).length;
  const isFav = FAVS.includes(svc.key);
  const cardCls = 'card' + ([S.DEG, S.PART, S.MAJ].includes(r.status) ? ' card-alert' : '');
  const compList = r.components.length
    ? r.components.map(c =>
        '<div class="comp-row"><span class="' + dotClass(c.status) + '"></span>' +
        '<span class="comp-name">' + esc(c.name) + (c.group ? ' <span class="comp-group">' + esc(c.group) + '</span>' : '') + '</span>' +
        '<span class="comp-status">' + esc(STATUS_LABEL[c.status] || c.status) + '</span></div>').join('')
    : '<div class="coverage-note">No per-function breakdown published by this feed.</div>';
  const incList = r.incidents.length
    ? r.incidents.map(incidentRow).join('')
    : '<div class="coverage-note">No incidents on record.</div>';

  const staleDays = r.updatedAt ? Math.floor((Date.now() - new Date(r.updatedAt).getTime()) / 86400000) : -1;
  const staleNote = (staleDays > 7)
    ? '<div class="coverage-note">This feed last published an update ' + staleDays + 'd ago — data may be stale.</div>'
    : '';

  return '<article class="' + cardCls + '" data-key="' + esc(svc.key) + '">' +
    '<div class="card-head">' +
      '<div class="logo-frame">' + logoHtml(svc) + '</div>' +
      '<div class="card-title"><h2>' + esc(svc.name) + '</h2><div class="card-cat">' + esc(svc.category) + '</div></div>' +
      '<button class="fav-btn' + (isFav ? ' fav-on' : '') + '" type="button" data-fav="' + esc(svc.key) + '"' +
        ' aria-pressed="' + isFav + '" title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '">★</button>' +
      '<span class="' + pillClass(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
    '</div>' +
    '<div class="card-stats"><span><b>' + r.components.length + '</b> ' + esc(pluralWord(r.components.length, 'function', 'functions')) + '</span>' +
      '<span><b>' + r.incidents.length + '</b> ' + esc(pluralWord(r.incidents.length, 'incident', 'incidents')) + '</span>' +
      (affected ? '<span><b>' + affected + '</b> affected</span>' : '') +
      (inMaint ? '<span><b>' + inMaint + '</b> in maintenance</span>' : '') +
      '<span style="margin-left:auto" class="mono" title="' + esc(fmtTime(r.updatedAt)) + '">' + esc(timeAgo(r.updatedAt)) + '</span></div>' +
    (r.note ? '<div class="coverage-note">' + esc(r.note) + '</div>' : '') +
    (r.feedNote ? '<div class="coverage-note feed-warn">' + esc(r.feedNote) + '</div>' : '') +
    staleNote +
    '<div class="details">' +
      detailsToggle(svc.key, 'comp', 'Functions', r.components.length) +
      '<div class="details-body' + (OPEN.has('comp-' + svc.key) ? ' open' : '') + '" id="comp-' + esc(svc.key) + '">' + compList + '</div>' +
      detailsToggle(svc.key, 'inc', 'Incidents', r.incidents.length) +
      '<div class="details-body' + (OPEN.has('inc-' + svc.key) ? ' open' : '') + '" id="inc-' + esc(svc.key) + '">' + incList + '</div>' +
    '</div>' +
    '<div class="card-links">' +
      '<a class="link-btn" href="' + esc(svc.status_page_url) + '" target="_blank" rel="noopener">Status page ↗</a>' +
      '<a class="link-btn" href="' + esc(svc.support_url) + '" target="_blank" rel="noopener">' + esc(svc.support_label || 'Support') + ' ↗</a>' +
    '</div>' +
  '</article>';
}

function currentFilter() {
  return {
    q: ($('#search').value || '').trim().toLowerCase(),
    cat: $('#category').value,
    problemsOnly: $('#problems-only').checked
  };
}

function matches(svc, f) {
  if (f.cat && svc.category !== f.cat) return false;
  if (f.problemsOnly && ![S.DEG, S.PART, S.MAJ, S.UNK].includes(svc.overall_status)) return false;
  if (f.q) {
    const hay = (svc.name + ' ' + svc.category + ' ' +
      (svc.components || []).map(c => c.name).join(' ')).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function bySeverity(a, b) {
  const ra = RANK[a.overall_status] || 0, rb = RANK[b.overall_status] || 0;
  return rb - ra || a.name.localeCompare(b.name);
}

function wireCardEvents(scope) {
  scope.querySelectorAll('.details-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = document.getElementById(btn.dataset.target);
      if (!body) return;
      const open = body.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) OPEN.add(btn.dataset.target); else OPEN.delete(btn.dataset.target);
    });
  });
  scope.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleFav(btn.dataset.fav));
  });
}

function render() {
  const f = currentFilter();
  const favSet = new Set(FAVS);
  const visible = SERVICES.filter(s => matches(s, f)).sort(bySeverity);
  const favs = visible.filter(s => favSet.has(s.key));
  const rest = visible.filter(s => !favSet.has(s.key));

  $('#result-count').textContent = visible.length + ' of ' + SERVICES.length + ' vendors';
  $('#fav-hint').hidden = FAVS.length > 0;

  const favSection = $('#fav-section');
  if (FAVS.length) {
    favSection.hidden = false;
    $('#fav-count').textContent = '(' + FAVS.length + '/' + MAX_FAVS + ')';
    $('#all-title').hidden = false;
    $('#fav-grid').innerHTML = favs.length
      ? favs.map(cardHtml).join('')
      : '<div class="empty-state"><h3>No favorites match the current filters</h3><p>Your pinned vendors are hidden by the search/filter above.</p></div>';
    wireCardEvents($('#fav-grid'));
  } else {
    favSection.hidden = true;
    $('#all-title').hidden = true;
  }

  const grid = $('#grid');
  if (!rest.length) {
    grid.innerHTML = '<div class="empty-state"><h3>' +
      (visible.length ? 'Everything else is pinned above' : 'No vendors match') +
      '</h3><p>' + (visible.length ? 'All matching vendors are in your favorites.' : 'Try a different search term or clear the filters.') + '</p></div>';
  } else {
    grid.innerHTML = rest.map(cardHtml).join('');
  }
  wireCardEvents(grid);
  if (!firstPaintDone) {
    firstPaintDone = true;
    grid.classList.add('painted');
    const fg = $('#fav-grid');
    if (fg) fg.classList.add('painted');
  }
  renderKpis();
}

function renderKpis() {
  let ok = 0, issues = 0, incidents = 0, maint = 0, unknown = 0;
  SERVICES.forEach(s => {
    if (s.overall_status === S.OK) ok++;
    else if ([S.DEG, S.PART, S.MAJ].includes(s.overall_status)) issues++;
    else if (s.overall_status === S.MAINT) maint++;
    else unknown++;
    incidents += (s.incidents || []).filter(i => !ACTIVE_EXCLUDE.includes(String(i.status).toLowerCase())).length;
  });
  $('#kpi-operational').textContent = ok;
  $('#kpi-issues').textContent = issues;
  $('#kpi-incidents').textContent = incidents;
  $('#kpi-maintenance').textContent = maint;
  $('#kpi-unknown').textContent = unknown;
  if (SERVICES.length) {
    document.title = Math.round(ok / SERVICES.length * 100) + '% operational — SaaS Status';
  }
}

function renderHealth() {
  const el = $('#feed-health');
  const entries = Object.values(HEALTH);
  if (!entries.length) { el.textContent = '—'; return; }
  const failing = entries.filter(h => h.consecutive_failures > 0).length;
  const stale = entries.filter(h => h.stale).length;
  el.textContent = failing
    ? failing + ' feed' + (failing === 1 ? '' : 's') + ' failing'
    : entries.length + '/' + entries.length + ' feeds OK';
  el.title = stale ? stale + ' feed(s) stale — see /api/health' : 'All feeds healthy — see /api/health';
  el.classList.toggle('health-bad', failing > 0);
}

let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 3400);
}

/* ---------- data cycle ---------- */
async function loadData() {
  const [sRes, hRes] = await Promise.all([
    fetch('/api/statuses', { cache: 'no-store' }),
    fetch('/api/health', { cache: 'no-store' }).catch(() => null)
  ]);
  if (!sRes.ok) throw new Error('statuses HTTP ' + sRes.status);
  const data = await sRes.json();
  SERVICES = data.services || [];
  lastRefreshed = data.last_refreshed;
  if (hRes && hRes.ok) {
    const h = await hRes.json();
    HEALTH = h.vendors || {};
    if (h.poll_interval_ms) {
      $('#next-refresh').textContent = 'every ' + Math.round(h.poll_interval_ms / 60000) + ' min';
    }
  }
  $('#vendor-count').textContent = SERVICES.length;
  $('#last-updated').textContent = lastRefreshed ? new Date(lastRefreshed).toLocaleTimeString() : '—';
  renderHealth();
  render();
}

async function refreshNow() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    const j = await r.json();
    await loadData();
    showToast('Updated ' + (j.polled || SERVICES.length) + ' vendors · ' +
      SERVICES.filter(s => [S.DEG, S.PART, S.MAJ].includes(s.overall_status)).length + ' with issues');
  } catch (e) {
    showToast('Refresh failed — server unreachable.');
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

/* ---------- boot ---------- */
async function boot() {
  try {
    await loadData();
  } catch (e) {
    $('#grid').innerHTML = '<div class="empty-state"><h3>Could not load statuses</h3><p>The status API is unreachable. Check the server, then reload.</p></div>';
    return;
  }
  const cats = [...new Set(SERVICES.map(s => s.category))].sort();
  const sel = $('#category');
  cats.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
  let deb;
  $('#search').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(render, 160); });
  sel.addEventListener('change', render);
  $('#problems-only').addEventListener('change', render);
  $('#refresh-btn').addEventListener('click', refreshNow);
  /* the server polls feeds itself; the UI just re-reads its cache each minute */
  setInterval(() => { loadData().catch(() => {}); }, 60000);
}

document.addEventListener('DOMContentLoaded', boot);
