import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import report from '../netlify/functions/report.mjs';

const apiBody = JSON.parse(readFileSync(new URL('./api-report.json', import.meta.url), 'utf8'));
const RANGE = 'https://report.example/api/report?from=2026-09-01T07:00:00.000Z&to=2026-09-10T07:00:00.000Z';
const KEYS = ['REPORT_API_KEY', 'REPORT_API_URL', 'REPORT_AUTH_USER', 'REPORT_AUTH_PASSWORD', 'REPORT_SOURCE', 'REPORT_ALLOWED_IPS'];
const OFFICE = '98.122.179.148';
const STRANGER = '203.0.113.9';

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
  delete process.env.REPORT_ALLOWED_IPS;
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

/** Netlify's context for a request that arrived from `ip`. */
const from = (ip) => ({ ip });

/** The site set up with an address list and no sign-in at all. */
function addressesOnly(list = OFFICE) {
  delete process.env.REPORT_AUTH_USER;
  delete process.env.REPORT_AUTH_PASSWORD;
  process.env.REPORT_ALLOWED_IPS = list;
}

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

// ------------------------------------------------------------ address list --

test('an allowed address gets the report without signing in', async () => {
  addressesOnly();
  const res = await report(new Request(RANGE), from(OFFICE));
  assert.equal(res.status, 200);
  assert.equal(calls[0].init.headers['x-admin-key'], 'admin-key', 'the admin key is still what the API sees');
});

test('any other address is refused, and told which address the site saw', async () => {
  addressesOnly();
  const res = await report(new Request(RANGE), from(STRANGER));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /203\.0\.113\.9.*REPORT_ALLOWED_IPS/);
  assert.equal(calls.length, 0, 'the API is never asked on behalf of a refused visitor');
});

test('a forged forwarding header does not get anyone in', async () => {
  addressesOnly();
  const forged = new Request(RANGE, {
    headers: { 'X-Forwarded-For': OFFICE, 'X-Real-IP': OFFICE, 'x-nf-client-connection-ip': OFFICE },
  });
  const res = await report(forged, from(STRANGER));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('with no address from Netlify at all, the list lets nobody in', async () => {
  addressesOnly();
  const res = await report(new Request(RANGE, { headers: { 'X-Forwarded-For': OFFICE } }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('an IPv4 address written the IPv6 way still matches', async () => {
  addressesOnly();
  assert.equal((await report(new Request(RANGE), from(`::ffff:${OFFICE}`))).status, 200);
});

test('several addresses can be listed, spaced and in either case', async () => {
  addressesOnly(` ${OFFICE} , 2001:DB8::1 `);
  assert.equal((await report(new Request(RANGE), from('2001:db8::1'))).status, 200);
  assert.equal((await report(new Request(RANGE), from(OFFICE))).status, 200);
  assert.equal((await report(new Request(RANGE), from(STRANGER))).status, 403);
});

test('with a password set too, other addresses are asked to sign in rather than refused', async () => {
  process.env.REPORT_ALLOWED_IPS = OFFICE; // the sign-in pair from beforeEach stays set
  assert.equal((await report(new Request(RANGE), from(OFFICE))).status, 200, 'listed: straight in');
  assert.equal((await report(new Request(RANGE), from(STRANGER))).status, 401, 'unlisted: asked to sign in');
  assert.equal((await report(new Request(RANGE, signedIn()), from(STRANGER))).status, 200, 'unlisted but signed in');
});

test('a mistyped address is reported as a setting problem, not silently never matched', async () => {
  addressesOnly('98.122.179');
  const res = await report(new Request(RANGE), from(OFFICE));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /"98\.122\.179", which is not an IP address/);
  assert.equal(calls.length, 0);
});

test('with neither an address list nor a password, nothing is served', async () => {
  delete process.env.REPORT_AUTH_USER;
  delete process.env.REPORT_AUTH_PASSWORD;
  const res = await report(new Request(RANGE), from(OFFICE));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /REPORT_ALLOWED_IPS/);
  assert.equal(calls.length, 0);
});
