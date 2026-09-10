import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createApiSource, fromApiReport } from '../server/api.js';
import { buildReport } from '../server/report.js';
import { sessionRows, signInRows } from './fixtures.js';

// Produced by CEU-Website's own service.report() over test/fixtures.js, so this
// is exactly what GET /api/admin/report returns for those rows.
const apiBody = JSON.parse(readFileSync(new URL('./api-report.json', import.meta.url), 'utf8'));

const range = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-11T00:00:00Z') };
const viaApi = fromApiReport(apiBody);
const viaSql = buildReport(sessionRows, signInRows, range);

const without = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const sorted = (row) => ({ ...row, ipAddresses: [...row.ipAddresses].sort(), locations: [...row.locations].sort() });
const byId = (rows, id) => Object.fromEntries(rows.map((r) => [r[id], sorted(r)]));

test('API and database paths give the same tiles', () => {
  assert.deepEqual(viaApi.totals, viaSql.totals);
  assert.equal(viaApi.source, 'api');
  assert.equal(viaApi.geoipConfigured, false);
  assert.equal(viaApi.demoHidden, null);
  assert.deepEqual(viaApi.range, viaSql.range);
});

test('API and database paths give the same people', () => {
  const api = byId(viaApi.students, 'key');
  const sql = byId(viaSql.students, 'key');
  // The API takes a sign-in-only person's state from their first visit, even when that one left it blank.
  assert.equal(api['TX-9'].state, null);
  assert.equal(sql['TX-9'].state, 'TX');
  delete api['TX-9'].state;
  delete sql['TX-9'].state;
  assert.deepEqual(api, sql);
});

test('API and database paths give the same courses', () => {
  assert.deepEqual(byId(viaApi.courses, 'id'), byId(viaSql.courses, 'id'));
});

test('API and database paths give the same sittings and sign-ins', () => {
  // The API upper-cases the licence it shows; the database path shows it as typed.
  assert.deepEqual(viaApi.sittings.map((s) => without(s, 'license')), viaSql.sittings.map((s) => without(s, 'license')));
  assert.deepEqual(viaApi.signIns.map((v) => without(v, 'id', 'license')), viaSql.signIns.map((v) => without(v, 'id', 'license')));
});

test('raw addresses from the API lose their port before grouping', () => {
  assert.ok(apiBody.students.find((s) => s.licence === 'NC-12345').addresses.includes('98.122.179.148:61347'));
  assert.deepEqual(viaApi.students.find((s) => s.key === 'NC-12345').ipAddresses, ['98.122.179.148']);
  assert.equal(viaApi.sittings.find((s) => s.id === 'S1').ip, '98.122.179.148:61347', 'CSV keeps the stored value');
});

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url: new URL(url), init });
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const window = { from: new Date('2026-09-01T07:00:00Z'), to: new Date('2026-09-10T07:00:00Z') };
const source = (fetchImpl) => createApiSource({ url: 'https://api.example', key: 'secret', fetchImpl });

test('sends the key and the exact window, and never follows a redirect', async () => {
  const seen = [];
  const report = await source(fakeFetch(200, apiBody, seen)).report({ ...window, includeDemo: true });
  assert.equal(report.totals.people, 6);
  const { url, init } = seen[0];
  assert.equal(url.origin, 'https://api.example');
  assert.equal(url.pathname, '/api/admin/report');
  assert.equal(url.searchParams.get('from'), '2026-09-01T07:00:00.000Z');
  assert.equal(url.searchParams.get('to'), '2026-09-10T07:00:00.000Z');
  assert.equal(url.searchParams.get('demo'), '1');
  assert.equal(init.headers['x-admin-key'], 'secret');
  assert.equal(init.redirect, 'error');
});

test('leaves demo out unless asked', async () => {
  const seen = [];
  await source(fakeFetch(200, apiBody, seen)).report(window);
  assert.equal(seen[0].url.searchParams.has('demo'), false);
});

test('tells a wrong key apart from an API that lacks the endpoint', async () => {
  await assert.rejects(source(fakeFetch(404, { error: 'not_found', message: 'No such endpoint.' })).report(window), /refused the admin key/);
  await assert.rejects(source(fakeFetch(404, { error: 'not_found' })).report(window), /no report endpoint yet/);
});

test('describes a refused key by length and fingerprint, never by value', async () => {
  const refused = fakeFetch(404, { error: 'not_found', message: 'No such endpoint.' });
  const error = await source(refused).report(window).catch((e) => e);
  // 2bb80d53 is the start of the published SHA-256 of "secret" -- a fixed
  // value, not the code's own arithmetic repeated back to it.
  assert.match(error.message, /REPORT_API_KEY is 6 characters, fingerprint 2bb80d53\.$/);
  assert.ok(!error.message.includes('secret'), 'the key itself never appears');

  const pasted = createApiSource({ url: 'https://api.example', key: ' "secret" \n', fetchImpl: refused });
  const padded = await pasted.report(window).catch((e) => e);
  assert.match(padded.message, /8 characters, fingerprint [0-9a-f]{8} \(it has spaces or line breaks around it; it is wrapped in quotes\)/);
});

test('explains other refusals', async () => {
  await assert.rejects(source(fakeFetch(400, { error: 'bad_range', message: 'Not a date: x' })).report(window), /rejected the date range: Not a date: x/);
  await assert.rejects(source(fakeFetch(429, { error: 'rate_limited' })).report(window), /rate-limiting/);
  await assert.rejects(source(fakeFetch(500, undefined)).report(window), /answered 500\./);
});

test('network failures and non-report answers', async () => {
  const offline = async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.example') });
  };
  await assert.rejects(source(offline).report(window), /Could not reach the API at https:\/\/api\.example: getaddrinfo ENOTFOUND/);
  await assert.rejects(source(fakeFetch(200, { hello: 'world' })).report(window), /not with a report/);
});
