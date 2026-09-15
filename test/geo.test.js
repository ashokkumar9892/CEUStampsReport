import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocator, fillLocations, PROVIDERS, withLocations } from '../server/geo.js';
import { buildReport } from '../server/report.js';
import { sessionRows, signInRows } from './fixtures.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers per provider host, and records every address sent. */
function fakeFetch(answers, sent = []) {
  return async (url) => {
    const u = new URL(url);
    sent.push(`${u.host} ${decodeURIComponent(u.pathname)}`);
    const answer = answers[u.host];
    if (typeof answer === 'function') return answer(u);
    if (answer instanceof Error) throw answer;
    return answer ?? json(500, {});
  };
}

test('asks ipwho.is first, for city, region and country only', async () => {
  const sent = [];
  const locate = createLocator({
    fetchImpl: fakeFetch({ 'ipwho.is': (u) => {
      assert.equal(u.searchParams.get('fields'), 'success,message,city,region,country');
      return json(200, { success: true, city: 'Austin', region: 'Texas', country: 'United States' });
    } }, sent),
  });
  assert.equal(await locate('198.51.100.9'), 'Austin, Texas, United States');
  assert.deepEqual(sent, ['ipwho.is /198.51.100.9']);
});

test('falls back to db-ip.com when ipwho.is fails, is limited, or cannot place it', async () => {
  const dbip = json(200, { city: 'Portland', stateProv: 'Oregon', countryName: 'United States' });
  for (const first of [json(429, {}), new TypeError('fetch failed'), json(200, { success: false, message: 'limit' })]) {
    const locate = createLocator({ fetchImpl: fakeFetch({ 'ipwho.is': first, 'api.db-ip.com': dbip.clone() }) });
    assert.equal(await locate('203.0.113.7'), 'Portland, Oregon, United States');
  }
});

test('never sends a private or loopback address anywhere', async () => {
  const sent = [];
  const locate = createLocator({ fetchImpl: fakeFetch({}, sent) });
  for (const ip of ['::1', '127.0.0.1', '10.0.0.5', '192.168.1.4', '172.16.0.1', 'fd12::1', null, '']) {
    assert.equal(await locate(ip), null, String(ip));
  }
  assert.deepEqual(sent, []);
});

test('remembers answers, so a second run does not ask again', async () => {
  const sent = [];
  let t = 0;
  const locate = createLocator({
    now: () => t,
    fetchImpl: fakeFetch({
      'ipwho.is': () => json(200, { success: true, city: 'Austin', region: 'Texas', country: 'United States' }),
    }, sent),
  });
  await locate('198.51.100.9');
  await locate('198.51.100.9');
  assert.equal(sent.length, 1);

  // An address nobody could place is retried later, not on every run.
  const missSent = [];
  const miss = createLocator({ now: () => t, fetchImpl: fakeFetch({}, missSent) });
  await miss('203.0.113.8');
  await miss('203.0.113.8');
  assert.equal(missSent.length, 2, 'both providers asked once');
  t += 31 * 60 * 1000;
  await miss('203.0.113.8');
  assert.equal(missSent.length, 4, 'and again after half an hour');
});

test('fills locations on rows, people, courses and the tile', async () => {
  const report = buildReport(sessionRows, signInRows, {});
  const before = report.totals.locations;
  const sent = [];
  const places = {
    '198.51.100.9': ['Austin', 'Texas'],
    '203.0.113.50': ['Tampa', 'Florida'],
  };
  const locate = createLocator({
    fetchImpl: fakeFetch({
      'ipwho.is': (u) => {
        const place = places[decodeURIComponent(u.pathname.slice(1))];
        return json(200, place ? { success: true, city: place[0], region: place[1], country: 'United States' } : { success: false });
      },
      'api.db-ip.com': json(200, { errorCode: 'INVALID_ADDRESS' }),
    }, sent),
  });

  await fillLocations(report, locate);

  const tx = report.signIns.filter((v) => v.personKey === 'TX-9');
  assert.ok(tx.every((v) => v.location === 'Austin, Texas, United States' && v.locationLookedUp));
  assert.equal(report.sittings.find((s) => s.id === 'S5').location, 'Tampa, Florida, United States');
  assert.equal(report.sittings.find((s) => s.id === 'S1').location, 'Concord, North Carolina, United States', 'a stored location is kept');
  assert.equal(report.sittings.find((s) => s.id === 'S1').locationLookedUp, undefined);

  assert.deepEqual(report.students.find((p) => p.key === 'TX-9').locations, ['Austin, Texas, United States']);
  assert.deepEqual(report.students.find((p) => p.key === 'FL-1').locations, ['Tampa, Florida, United States']);
  assert.deepEqual(report.courses.find((c) => c.id === 'legacy-course').locations, ['Tampa, Florida, United States']);
  assert.equal(report.totals.locations, before + 3, 'two TX-9 sign-ins and one sitting');
  assert.equal(report.geoipConfigured, true);
  assert.deepEqual(report.locationLookup, { addresses: 2, placed: 2 });

  // Only public addresses without a location were sent, each once.
  assert.deepEqual(
    [...new Set(sent.map((s) => s.split(' ')[1]))].sort(),
    ['/198.51.100.9', '/203.0.113.50'],
  );
});

test('gives up at the deadline and leaves the rest unresolved', async () => {
  const report = buildReport(sessionRows, signInRows, {});
  let calls = 0;
  const locate = async () => {
    calls += 1;
    return 'Somewhere';
  };
  await fillLocations(report, locate, { deadline: Date.now() - 1 });
  assert.equal(calls, 0);
  assert.equal(report.signIns.find((v) => v.personKey === 'TX-9').location, null);
});

test('a report source wrapped with lookups still returns its report', async () => {
  const source = { report: async () => buildReport(sessionRows, signInRows, {}) };
  const wrapped = withLocations(source, async () => 'Somewhere, Nowhere');
  const report = await wrapped.report({});
  assert.equal(report.signIns.find((v) => v.personKey === 'TX-9').location, 'Somewhere, Nowhere');
});

test('the providers are HTTPS', () => {
  for (const p of PROVIDERS) assert.equal(new URL(p.url('8.8.8.8')).protocol, 'https:', p.name);
});
