/* SQLite storage (built-in node:sqlite — no native dependencies).
   Tables:
     latest(key, payload, fetched_at)   — newest parsed status per vendor
     health(key, payload)               — feed-health bookkeeping per vendor
     history(date, payload)             — one reliability record per day (NY) */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS latest (key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
    this.q = {
      upLatest: this.db.prepare('INSERT INTO latest(key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at'),
      getLatest: this.db.prepare('SELECT key, payload, fetched_at FROM latest'),
      upHealth: this.db.prepare('INSERT INTO health(key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload'),
      getHealth: this.db.prepare('SELECT key, payload FROM health'),
      upHistory: this.db.prepare('INSERT INTO history(date, payload) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET payload = excluded.payload'),
      getHistory: this.db.prepare('SELECT date, payload FROM history ORDER BY date ASC')
    };
  }

  saveLatest(key, payload, fetchedAt) {
    this.q.upLatest.run(key, JSON.stringify(payload), fetchedAt);
  }

  getLatest() {
    return this.q.getLatest.all().map(r => ({ key: r.key, fetched_at: r.fetched_at, payload: JSON.parse(r.payload) }));
  }

  saveHealth(key, payload) {
    this.q.upHealth.run(key, JSON.stringify(payload));
  }

  getHealth() {
    const out = {};
    for (const r of this.q.getHealth.all()) out[r.key] = JSON.parse(r.payload);
    return out;
  }

  saveHistoryDay(date, payload) {
    this.q.upHistory.run(date, JSON.stringify(payload));
  }

  getHistory() {
    return this.q.getHistory.all().map(r => ({ date: r.date, ...JSON.parse(r.payload) }));
  }

  close() { this.db.close(); }
}

module.exports = { Store };
