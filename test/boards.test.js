/* Boards: config loading, lookup, filtering. */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBoardsConfig, boardByName, filterByBoard } = require('../server/boards');

const svcs = [{ key: 'slack' }, { key: 'github' }, { key: 'zoom' }];

test('missing boards file -> single all board', () => {
  const boards = loadBoardsConfig({}, () => { throw new Error('no file'); });
  assert.deepEqual(boards, [{ name: 'all', title: 'All vendors', vendors: '*' }]);
});

test('valid config parsed; bad names skipped; vendors deduped', () => {
  const json = JSON.stringify([
    { name: 'core', title: 'Core stack', vendors: ['slack', 'github', 'slack'] },
    { name: 'Bad Name!', title: 'nope', vendors: ['zoom'] },
    { name: 'all', vendors: '*' }
  ]);
  const boards = loadBoardsConfig({}, () => json);
  assert.equal(boards.length, 2);
  assert.equal(boards[0].name, 'core');
  assert.deepEqual(boards[0].vendors, ['slack', 'github']);
  assert.equal(boards[1].vendors, '*');
});

test('filterByBoard: star returns all; list filters; unknown board lookup null', () => {
  assert.equal(filterByBoard(svcs, { vendors: '*' }).length, 3);
  assert.deepEqual(filterByBoard(svcs, { vendors: ['slack'] }).map(s => s.key), ['slack']);
  assert.equal(boardByName([{ name: 'core' }], 'nope'), null);
});
