import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerReport } from '../server/endpoint.js';
import { createLocator } from '../server/geo.js';
import { createRads10Source, fillVisitLocations, fromRads10Usage } from '../server/rads10.js';

const quiet = { error() {} };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001'; // browses, never logs in
const KMEN = 'bbbbbbbb-0000-4000-8000-000000000002'; // logs in to a station account
const OWNER = 'cccccccc-0000-4000-8000-000000000003'; // has the admin dashboard open
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const view = (at, visitor, visit, path, extra = {}) => ({
  at: `2026-10-${at}.000Z`, visitor, visit, path, referrer: null, station: null, stationName: null, role: null,
  account: null, accountName: null, ip: '203.0.113.9', device: CHROME, activeSeconds: null, lastActiveAt: null, ...extra,
});

/** What GET /api/rads10/admin/usage answers: page views newest first, and shop clicks. */
const usage = () => ({
  range: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z' },
  truncated: false,
  views: [
    view('09T10:00:00', OWNER, 'v-owner', '/admin', { role: 'admin', account: 'admin', ip: '198.51.100.7' }),
    view('08T09:05:00', KMEN, 'v-kmen', '/station', { role: 'station', account: 'KMEN', accountName: 'K-Men Radio', activeSeconds: 90, ip: '192.0.2.44:51000' }),
    view('08T09:00:00', KMEN, 'v-kmen', '/', { activeSeconds: 10, ip: '192.0.2.44:51000' }),
    view('05T18:00:00', ANA, 'v-ana-2', '/kmen', { station: 'KMEN', stationName: 'K-Men Radio', ip: '198.51.100.20' }),
    view('02T12:03:00', ANA, 'v-ana-1', '/kmen', { station: 'KMEN', stationName: 'K-Men Radio', activeSeconds: 30 }),
    view('02T12:01:00', ANA, 'v-ana-1', '/catch', { activeSeconds: 45 }),
    view('02T12:00:00', ANA, 'v-ana-1', '/', { referrer: 'www.google.com', activeSeconds: 5 }),
  ],
  clicks: [
    { slug: 'tea-shop', shop: 'The Tea Shop', station: 'KMEN', stationName: 'K-Men Radio', clicks: 4, lastAt: '2026-10-05T18:02:00.000Z' },
    { slug: 'tea-shop', shop: 'The Tea Shop', station: 'RADS', stationName: null, clicks: 1, lastAt: '2026-10-03T08:00:00.000Z' },
    { slug: 'sock-co', shop: 'Sock Co', station: 'KMEN', stationName: 'K-Men Radio', clicks: 2, lastAt: '2026-10-04T08:00:00.000Z' },
  ],
});

test('a unique visitor is a browser, however many visits and pages it made', () => {
  const report = fromRads10Usage(usage());
  assert.equal(report.totals.visitors, 2);
  assert.equal(report.totals.visits, 3);
  assert.equal(report.totals.pageViews, 6);

  const ana = report.visitors.find((v) => v.key === ANA);
  assert.equal(ana.visits, 2);
  assert.equal(ana.pageViews, 4);
  assert.deepEqual(ana.pages, ['/', '/catch', '/kmen']);
  assert.equal(ana.firstSeen, '2026-10-02T12:00:00.000Z');
  assert.equal(ana.lastSeen, '2026-10-05T18:00:00.000Z');
  assert.deepEqual(ana.ipAddresses, ['198.51.100.20', '203.0.113.9'], 'newest address first');
  assert.equal(ana.station, 'KMEN');
});

test('a visitor who never logged in has no name, only the start of the browser id', () => {
  const ana = fromRads10Usage(usage()).visitors.find((v) => v.key === ANA);
  assert.equal(ana.kind, 'Visitor');
  assert.equal(ana.name, 'Visitor aaaaaaaa');
  assert.equal(ana.account, null);
});

test('logging in once names every page that browser opened in the range', () => {
  const report = fromRads10Usage(usage());
  const station = report.visitors.find((v) => v.key === KMEN);
  assert.equal(station.kind, 'Station');
  assert.equal(station.name, 'K-Men Radio');
  assert.equal(report.totals.accounts, 1);
  const visit = report.visits.find((v) => v.id === 'v-kmen');
  assert.equal(visit.name, 'K-Men Radio');
  assert.equal(visit.landing, '/', 'the page opened before logging in belongs to the same visit');
  assert.equal(visit.ipAddress, '192.0.2.44', 'the port App Service adds is not part of the address');
});

test('the owner is left out unless asked for, and the report says how many were hidden', () => {
  const hidden = fromRads10Usage(usage());
  assert.equal(hidden.adminHidden, 1);
  assert.ok(!hidden.visitors.some((v) => v.key === OWNER));
  assert.ok(!hidden.pages.some((p) => p.path === '/admin'));

  const shown = fromRads10Usage(usage(), { includeAdmin: true });
  assert.equal(shown.adminHidden, 0);
  assert.equal(shown.totals.visitors, 3);
  assert.equal(shown.visitors.find((v) => v.key === OWNER).kind, 'Admin');
});

test('a visit is its pages in the order they were opened, and its time is the pages added up', () => {
  const visit = fromRads10Usage(usage()).visits.find((v) => v.id === 'v-ana-1');
  assert.deepEqual(visit.pages, ['/', '/catch', '/kmen']);
  assert.equal(visit.landing, '/');
  assert.equal(visit.referrer, 'www.google.com');
  assert.equal(visit.station, 'KMEN');
  assert.equal(visit.activeSeconds, 80);
  assert.equal(visit.startedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(visit.lastAt, '2026-10-02T12:03:00.000Z');
});

test('time that was never reported is "not recorded", not zero', () => {
  const report = fromRads10Usage(usage());
  assert.equal(report.visits.find((v) => v.id === 'v-ana-2').activeSeconds, null);
  assert.equal(report.visitors.find((v) => v.key === ANA).activeSeconds, 80);
  assert.equal(fromRads10Usage({ views: [view('02T12:00:00', ANA, 'v', '/')], clicks: [] }).totals.activeSeconds, null);
});

test('pages count views, and the different visitors and visits behind them', () => {
  const pages = Object.fromEntries(fromRads10Usage(usage()).pages.map((p) => [p.path, p]));
  assert.deepEqual([pages['/kmen'].views, pages['/kmen'].visitors, pages['/kmen'].visits], [2, 1, 2]);
  assert.deepEqual([pages['/'].views, pages['/'].visitors, pages['/'].visits], [2, 2, 2]);
  assert.equal(pages['/kmen'].lastAt, '2026-10-05T18:00:00.000Z');
});

test('shop clicks are totalled beside the visitors, and hiding the owner does not change them', () => {
  for (const includeAdmin of [false, true]) {
    const report = fromRads10Usage(usage(), { includeAdmin });
    assert.equal(report.totals.clicks, 7);
    assert.equal(report.totals.shopsClicked, 2);
    assert.equal(report.clicks.length, 3);
  }
});

test('an empty range is a report of zeros, not an error', () => {
  const report = fromRads10Usage({ views: [], clicks: [] });
  assert.deepEqual(
    [report.totals.visitors, report.totals.visits, report.totals.pageViews, report.totals.clicks, report.totals.activeSeconds],
    [0, 0, 0, 0, null],
  );
  assert.deepEqual([report.visitors, report.visits, report.pages, report.clicks], [[], [], [], []]);
});

test('addresses are placed when the report runs, newest visit first, and private ones are never sent', async () => {
  const sent = [];
  const places = { '203.0.113.9': 'Austin, Texas, United States', '198.51.100.20': 'Portland, Oregon, United States' };
  const locate = createLocator({
    fetchImpl: async (url) => {
      const ip = decodeURIComponent(new URL(url).pathname.slice(1));
      sent.push(ip);
      const [city, region, country] = (places[ip] ?? '').split(', ');
      return json(200, places[ip] ? { success: true, city, region, country } : { success: false });
    },
  });
  const body = usage();
  body.views.push(view('01T08:00:00', 'dddddddd-0000-4000-8000-000000000004', 'v-lan', '/', { ip: '192.168.1.20' }));
  const report = await fillVisitLocations(fromRads10Usage(body), locate, { deadline: Date.now() + 5000 });

  assert.ok(!sent.includes('192.168.1.20'));
  assert.equal(report.visits.find((v) => v.id === 'v-ana-1').location, 'Austin, Texas, United States');
  const ana = report.visitors.find((v) => v.key === ANA);
  assert.deepEqual(ana.locations, ['Portland, Oregon, United States', 'Austin, Texas, United States']);
  assert.equal(report.totals.locations, 2);
  assert.equal(report.totals.placed, 1, 'only Ana: the station\'s address has no place and the LAN one was never asked');
  assert.equal(report.locationLookup.addresses, 3);
});

const RANGE = { from: new Date('2026-10-01T07:00:00.000Z'), to: new Date('2026-10-11T07:00:00.000Z') };

test('asks the RADS10 usage endpoint for the exact instants, with the admin key', async () => {
  const calls = [];
  const source = createRads10Source({
    url: 'https://api.example',
    key: 'admin-key',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return json(200, usage());
    },
  });
  const report = await source.report({ ...RANGE, includeDemo: true });
  assert.equal(calls[0].url.pathname, '/api/rads10/admin/usage');
  assert.equal(calls[0].url.searchParams.get('from'), '2026-10-01T07:00:00.000Z');
  assert.equal(calls[0].init.headers['x-admin-key'], 'admin-key');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(report.site, 'rads10');
  assert.equal(report.includeAdmin, true, 'the page\'s one checkbox means admin visits here');
});

test('says what to do when the API does not record visits yet, or refuses the key', async () => {
  const failing = (status, body) =>
    createRads10Source({ url: 'https://api.example', key: 'k', fetchImpl: async () => json(status, body) }).report(RANGE);

  await assert.rejects(failing(404, { error: 'Not found' }), /does not record RADS10 visits yet.*013_rads10_visits\.sql/s);
  await assert.rejects(failing(404, { error: 'No such endpoint.' }), /refused the admin key.*REPORT_API_KEY/s);
  await assert.rejects(failing(429, { error: 'Too many requests.' }), /rate-limiting/);
  await assert.rejects(failing(200, { hello: 'world' }), /not with a RADS10 usage report/);
});

test('?site= picks the report, and CEU Stamps stays the default', async () => {
  const asked = [];
  const sources = {
    ceu: { report: async () => (asked.push('ceu'), { site: 'ceu' }) },
    rads10: { report: async () => (asked.push('rads10'), { site: 'rads10' }) },
  };
  const range = 'from=2026-10-01T07:00:00.000Z&to=2026-10-11T07:00:00.000Z';
  assert.equal((await answerReport(new URLSearchParams(range), sources, quiet)).body.site, 'ceu');
  assert.equal((await answerReport(new URLSearchParams(`${range}&site=rads10`), sources, quiet)).body.site, 'rads10');
  assert.equal((await answerReport(new URLSearchParams(`${range}&site=other`), sources, quiet)).status, 400);
  assert.deepEqual(asked, ['ceu', 'rads10']);

  // A server given a single source (the database one) has CEU Stamps only.
  const single = { report: async () => ({ site: 'ceu' }) };
  assert.equal((await answerReport(new URLSearchParams(range), single, quiet)).status, 200);
  assert.equal((await answerReport(new URLSearchParams(`${range}&site=rads10`), single, quiet)).status, 404);
});
