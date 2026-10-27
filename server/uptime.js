/* Uptime math (StatusGator-style SLA reporting).
   Definition, stated wherever numbers are shown: a poll counts as UP when
   the vendor is operational. Scheduled maintenance is EXCLUDED (the vendor
   is not "down"), and unknown (our feed failed) is excluded too — it says
   nothing about the vendor. Degraded/partial/major all count as DOWN.
   Downtime minutes are estimated as down_polls x poll interval, so the
   granularity is the poll cadence. Uptime % only covers periods since
   sample recording started (this release); earlier history is daily
   last-of-day records, which cannot produce a real uptime %. */
'use strict';

const DOWN = ['degraded', 'partial_outage', 'major_outage'];

function computeUptime(byStatus, pollIntervalMs) {
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const maint = byStatus.maintenance || 0;
  const unknown = byStatus.unknown || 0;
  const denom = total - maint - unknown;
  const downPolls = DOWN.reduce((a, s) => a + (byStatus[s] || 0), 0);
  if (denom <= 0) {
    return { uptime_pct: null, downtime_minutes: Math.round(downPolls * pollIntervalMs / 60000), polls: total, by_status: byStatus };
  }
  const up = byStatus.operational || 0;
  return {
    uptime_pct: Math.round((up / denom) * 10000) / 100,
    downtime_minutes: Math.round(downPolls * pollIntervalMs / 60000),
    polls: total,
    by_status: byStatus
  };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function uptimeCsv(rows, period) {
  const header = ['vendor', 'name', 'uptime_pct', 'downtime_minutes', 'polls', 'period_days', 'period_start', 'period_end'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.key, r.name, r.uptime_pct == null ? '' : r.uptime_pct, r.downtime_minutes, r.polls,
      period.days, period.start, period.end].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { computeUptime, uptimeCsv, csvEscape, DOWN };
