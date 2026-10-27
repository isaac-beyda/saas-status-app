/* Boards: named vendor sets ("Core stack", "Engineering", …) that act as
   shareable filtered views of the dashboard — StatusGator's board concept.
   Config: BOARDS_CONFIG path (default ./boards.json); if the file is
   missing or empty, a single "all" board is used. Board names are URL
   slugs; /board/<name> and ?board=<name> both select a board. */
'use strict';

const fs = require('node:fs');

function loadBoardsConfig(env = process.env, readFile = fs.readFileSync) {
  const path = env.BOARDS_CONFIG || './boards.json';
  let raw = null;
  try { raw = readFile(path, 'utf8'); } catch { raw = null; }
  if (!raw) return [{ name: 'all', title: 'All vendors', vendors: '*' }];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error('[boards] invalid JSON in', path + ':', e.message);
    return [{ name: 'all', title: 'All vendors', vendors: '*' }];
  }
  const list = Array.isArray(parsed) ? parsed : parsed.boards;
  if (!Array.isArray(list) || !list.length) return [{ name: 'all', title: 'All vendors', vendors: '*' }];
  const boards = [];
  for (const b of list) {
    if (!b || typeof b.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(b.name)) {
      console.warn('[boards] skipping board with invalid name:', b && b.name);
      continue;
    }
    boards.push({
      name: b.name,
      title: typeof b.title === 'string' && b.title ? b.title : b.name,
      vendors: b.vendors === '*' || !b.vendors ? '*' : [...new Set(b.vendors.filter(v => typeof v === 'string'))]
    });
  }
  return boards.length ? boards : [{ name: 'all', title: 'All vendors', vendors: '*' }];
}

function boardByName(boards, name) {
  return boards.find(b => b.name === name) || null;
}

function filterByBoard(services, board) {
  if (!board || board.vendors === '*') return services;
  const set = new Set(board.vendors);
  return services.filter(s => set.has(s.key));
}

module.exports = { loadBoardsConfig, boardByName, filterByBoard };
