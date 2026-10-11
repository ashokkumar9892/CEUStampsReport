import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import report from '../netlify/functions/report.mjs';

const apiBody = JSON.parse(readFileSync(new URL('./api-report.json', import.meta.url), 'utf8'));
const RANGE = 'https://report.example/api/report?from=2026-09-01T07:00:00.000Z&to=2026-09-10T07:00:00.000Z';
const KEYS = ['REPORT_API_KEY', 'REPORT_API_URL', 'REPORT_AUTH_USER', 'REPORT_AUTH_PASSWORD', 'REPORT_SOURCE', 'REPORT_ALLOWED_IPS', 'REPORT_GEOIP'];

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
  for (const k of KEYS) delete process.env[k];
  // Lookups off unless a test turns them on, so calls[] holds only the API request.
  Object.assign(process.env, { REPORT_API_KEY: 'admin-key', REPORT_API_URL: 'https://api.example', REPORT_GEOIP: 'off' });
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

test('refuses to serve anything until the admin key is configured', async () => {
  delete process.env.REPORT_API_KEY;
  const res = await report(new Request(RANGE));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /REPORT_API_KEY/);
  assert.equal(calls.length, 0);
});

test('opens for any address, with no sign-in', async () => {
  for (const ip of ['98.122.179.148', '203.0.113.9', '2001:db8::1', undefined]) {
    const res = await report(new Request(RANGE), ip ? from(ip) : undefined);
    assert.equal(res.status, 200, `from ${ip ?? 'no address at all'}`);
  }
});

test('an old address list left in Netlify no longer turns anyone away', async () => {
  process.env.REPORT_ALLOWED_IPS = '98.122.179.148';
  const res = await report(new Request(RANGE), from('203.0.113.9'));
  assert.equal(res.status, 200);
});

test('reads the report from the API with the admin key, which never reaches the browser', async () => {
  const res = await report(new Request(RANGE), from('203.0.113.9'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.source, 'api');
  assert.equal(body.totals.people, 6);
  assert.equal(calls[0].url.origin, 'https://api.example');
  assert.equal(calls[0].init.headers['x-admin-key'], 'admin-key');
  assert.equal(calls[0].url.searchParams.get('from'), '2026-09-01T07:00:00.000Z');
  assert.ok(!text.includes('admin-key'), 'the key is not in the response');
});

test('rejects a bad range before calling the API', async () => {
  const res = await report(new Request('https://report.example/api/report?from=2026-09-01&to=2026-09-10'));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('only GET', async () => {
  assert.equal((await report(new Request(RANGE, { method: 'POST' }))).status, 405);
  assert.equal(calls.length, 0);
});

test('setting a sign-in pair locks it again, for every address', async () => {
  Object.assign(process.env, { REPORT_AUTH_USER: 'ops', REPORT_AUTH_PASSWORD: 's3cret' });
  const res = await report(new Request(RANGE), from('98.122.179.148'));
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await report(new Request(RANGE, signedIn('ops', 'nope')))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await report(new Request(RANGE, signedIn()), from('203.0.113.9'))).status, 200);
});

test('only one half of the sign-in pair leaves it open rather than locking everyone out', async () => {
  process.env.REPORT_AUTH_USER = 'ops';
  assert.equal((await report(new Request(RANGE))).status, 200);
});

test('fills in city and state for addresses the API left unplaced', async () => {
  process.env.REPORT_GEOIP = 'on';
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.host === 'api.example') {
      return new Response(JSON.stringify(apiBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.host === 'ipwho.is') {
      const ip = decodeURIComponent(u.pathname.slice(1));
      const body = ip === '198.51.100.9'
        ? { success: true, city: 'Austin', region: 'Texas', country: 'United States' }
        : { success: false };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  };

  const body = await (await report(new Request(RANGE))).json();
  assert.ok(body.signIns.filter((v) => v.personKey === 'TX-9').every((v) => v.location === 'Austin, Texas, United States'));
  assert.equal(body.geoipConfigured, true);
  const lookedUp = calls.filter((c) => c.url.host !== 'api.example').map((c) => decodeURIComponent(c.url.pathname));
  assert.ok(lookedUp.every((p) => !/::1|10.0.0.5/.test(p)), 'private and loopback addresses are never sent');
  assert.ok(!calls.some((c) => c.url.host !== 'api.example' && 'x-admin-key' in (c.init?.headers ?? {})), 'the admin key goes only to the API');
});

test('?site=rads10 reads the RADS10 usage endpoint with the same key', async () => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ range: {}, truncated: false, views: [], clicks: [] }), { status: 200 });
  };
  const res = await report(new Request(`${RANGE}&site=rads10`));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.site, 'rads10');
  assert.equal(body.totals.visitors, 0);
  assert.equal(calls[0].url.pathname, '/api/rads10/admin/usage');
  assert.equal(calls[0].init.headers['x-admin-key'], 'admin-key');
});
