import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDirection, pageInfo, sortRows } from '../shared/table.js';

const rows = [{ v: 'b' }, { v: null }, { v: 'A' }, { v: '' }, { v: 'c' }];
const byV = (type) => ({ type, value: (r) => r.v });

test('text sorts A → Z, case-insensitively, empties last', () => {
  assert.deepEqual(sortRows(rows, byV('text'), 'asc').map((r) => r.v), ['A', 'b', 'c', null, '']);
});

test('empties stay last when reversed', () => {
  assert.deepEqual(sortRows(rows, byV('text'), 'desc').map((r) => r.v), ['c', 'b', 'A', null, '']);
});

test('numbers and dates compare by value', () => {
  const nums = [{ v: 9 }, { v: 10 }, { v: null }, { v: 0 }];
  assert.deepEqual(sortRows(nums, byV('number'), 'desc').map((r) => r.v), [10, 9, 0, null]);
  const dates = [{ v: '2026-09-02T00:00:00.000Z' }, { v: '2026-09-10T00:00:00.000Z' }, { v: null }];
  assert.deepEqual(sortRows(dates, byV('date'), 'desc').map((r) => r.v)[0], '2026-09-10T00:00:00.000Z');
});

test('default directions', () => {
  assert.equal(defaultDirection('text'), 'asc');
  assert.equal(defaultDirection('number'), 'desc');
  assert.equal(defaultDirection('date'), 'desc');
});

test('paging clamps and slices', () => {
  assert.deepEqual(pageInfo(23, 3, 10), { page: 3, pageCount: 3, start: 20, end: 23, total: 23 });
  assert.deepEqual(pageInfo(23, 9, 10).page, 3);
  assert.deepEqual(pageInfo(0, 1, 10), { page: 1, pageCount: 1, start: 0, end: 0, total: 0 });
});
