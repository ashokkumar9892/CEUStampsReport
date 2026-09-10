import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import report from '../netlify/functions/report.mjs';

const apiBody = JSON.parse(readFileSync(new URL('./api-report.json', import.meta.url), 'utf8'));
const RANGE = 'https://report.example/api/report?from=2026-09-01T07:00:00.000Z&to=2026-09-10T07:00:00.000Z';
const KEYS = ['REPORT_API_KEY', 'REPORT_API_URL', 'REPORT_AUTH_USER', 'REPORT_AUTH_PASSWORD', 'REPORT_SOURCE'];

let savedEnv;
let savedFetch;
let calls;

beforeEach(() => {
  savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify(apiBody), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  Object.assign(process.env, {
    REPORT_API_KEY: 'admin-key', REPORT_API_URL: 'https://api.example',
    REPORT_AUTH_USER: 'ops', REPORT_AUTH_PASSWORD: 's3cret',
  });
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const signedIn = (user = 'ops', password = 's3cret') => ({
  headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
});

test('refuses to serve anything until the key and a password are configured', async () => {
  delete process.env.REPORT_AUTH_PASSWORD;
  delete process.env.REPORT_API_KEY;
  const res = await report(new Request(RANGE, signedIn()));
  assert.equal(res.status, 500);
  const { error } = await res.json();
  assert.match(error, /REPORT_API_KEY/);
  assert.match(error, /REPORT_AUTH_USER and REPORT_AUTH_PASSWORD/);
  assert.equal(calls.length, 0);
});

test('asks for the password, and rejects a wrong one', async () => {
  const res = await report(new Request(RANGE));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await report(new Request(RANGE, signedIn('ops', 'nope')))).status, 401);
  assert.equal(calls.length, 0);
});

test('reads the report from the API with the admin key', async () => {
  const res = await report(new Request(RANGE, signedIn()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.source, 'api');
  assert.equal(body.totals.people, 6);
  assert.equal(calls[0].url.origin, 'https://api.example');
  assert.equal(calls[0].init.headers['x-admin-key'], 'admin-key');
  assert.equal(calls[0].url.searchParams.get('from'), '2026-09-01T07:00:00.000Z');
});

test('rejects a bad range before calling the API', async () => {
  const res = await report(new Request('https://report.example/api/report?from=2026-09-01&to=2026-09-10', signedIn()));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
