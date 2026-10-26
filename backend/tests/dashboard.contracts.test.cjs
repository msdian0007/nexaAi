const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDashboardRange, dashboardDates, DashboardInputError } = require('../dist/src/analytics/dashboard.contracts');
const now = new Date('2026-10-26T10:00:00.000Z');
const reject = input => assert.throws(() => parseDashboardRange(input, now), DashboardInputError);

test('defaults to seven UTC days including the partial current day', () => {
  const range = parseDashboardRange({}, now);
  assert.equal(range.from, '2026-10-20'); assert.equal(range.to, '2026-10-27'); assert.equal(range.days, 7);
  assert.equal(range.fromDate.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(range.toDate.toISOString(), '2026-10-27T00:00:00.000Z');
});

test('uses an exclusive end and supplies every day, including days without records', () => {
  const range = parseDashboardRange({ from: '2026-10-24', to: '2026-10-27' }, now);
  assert.deepEqual(dashboardDates(range), ['2026-10-24', '2026-10-25', '2026-10-26']);
  assert.equal(new Date('2026-10-27T00:00:00.000Z') < range.toDate, false);
  assert.equal(new Date('2026-10-26T23:59:59.999Z') < range.toDate, true);
});

test('valid leap days and year boundaries retain exact UTC calendar days', () => {
  const leap = parseDashboardRange({ from: '2024-02-28', to: '2024-03-02' }, now);
  assert.deepEqual(dashboardDates(leap), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(dashboardDates(parseDashboardRange({ from: '2025-12-31', to: '2026-01-02' }, now)), ['2025-12-31', '2026-01-01']);
});

test('rejects normalized invalid dates, timestamps, whitespace, arrays and wrong types', () => {
  for (const from of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00', '26-10-01',
    '2026-10-01T00:00:00Z', ' 2026-10-01', '0000-10-01', null, 42, ['2026-10-01']]) reject({ from, to: '2026-10-27' });
});

test('requires paired dates and rejects organization, user, role and arbitrary query overrides', () => {
  for (const query of [null, [], 'dates', new Date(), Object.create({ from: '2026-10-01', to: '2026-10-27' }), { from: '2026-10-01' }, { to: '2026-10-27' }, { from: undefined, to: undefined },
    { organizationId: 'other' }, { userId: 'peer' }, { role: 'OWNER' }, { timezone: 'Asia/Calcutta' },
    { from: '2026-10-01', to: '2026-10-27', sql: 'SELECT *' }]) reject(query);
});

test('caps windows at 90 days and rejects empty, inverted and future ranges', () => {
  assert.equal(parseDashboardRange({ from: '2026-07-29', to: '2026-10-27' }, now).days, 90);
  for (const query of [{ from: '2026-07-28', to: '2026-10-27' }, { from: '2026-10-26', to: '2026-10-26' },
    { from: '2026-10-27', to: '2026-10-26' }, { from: '2026-10-26', to: '2026-10-28' }, { from: '2026-10-27', to: '2026-10-28' }]) reject(query);
});

test('default boundaries follow UTC even when the current local date is already tomorrow in India', () => {
  const range = parseDashboardRange({}, new Date('2026-10-26T00:15:00+05:30'));
  assert.equal(range.from, '2026-10-19'); assert.equal(range.to, '2026-10-26');
  assert.equal(dashboardDates(range).at(-1), '2026-10-25');
});

test('UTC day buckets remain 24 hours across daylight-saving calendar dates', () => {
  const range = parseDashboardRange({ from: '2026-03-07', to: '2026-03-10' }, now);
  assert.equal(range.days, 3);
  assert.equal(range.toDate - range.fromDate, 3 * 86400000);
});

test('does not mutate query or server time and ignores forged precomputed bucket lengths', () => {
  const query = { from: '2026-10-24', to: '2026-10-27' };
  const original = { ...query }, time = now.getTime();
  const range = parseDashboardRange(query, now);
  assert.deepEqual(query, original); assert.equal(now.getTime(), time);
  assert.equal(dashboardDates({ ...range, days: 999999 }).length, 3);
});

test('contracts load without importing database, provider or queue services', () => {
  const loaded = Object.keys(require.cache).map(path => path.replaceAll('\\', '/'));
  for (const suffix of ['/config/database.js', '/config/redis.js', '/rag/gemini.provider.js']) {
    assert.equal(loaded.some(path => path.endsWith(suffix)), false);
  }
});
