// The RADS10 tab: who visits rads10.com and what they do there.
//
// RADS10 is a separate product on the same API (CEU-Website, server/src/rads10/).
// Its usage endpoint, GET /api/rads10/admin/usage, opens with the same admin key
// as the CEU Stamps report and returns raw page views and shop clicks for a date
// range; every rule below is applied here.
//
// - A visitor is a browser: a random id rads10.com keeps in it. Nobody signs in
//   to browse, so there is no name unless the browser was logged in to a station
//   or shop account.
// - A visit is one browser session of that visitor, made of page views.
// - Whoever has logged in to the RADS10 admin dashboard is the owner, and is left
//   out unless asked for.
// - Clicks through to shops are counted by the API with no visitor attached, so
//   they are reported beside the visitors, not under them.

import { ipKind, normalizeIp } from '../shared/format.js';
import { lookUpAll } from './geo.js';

const list = (v) => (Array.isArray(v) ? v : []);
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const distinct = (values) => [...new Set(values.filter(Boolean))];
const count = (v) => Number(v) || 0;
const duration = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));
/** Time on screen across rows; null when none of them recorded any. */
const totalSeconds = (rows) => (rows.some((r) => r.activeSeconds != null) ? rows.reduce((t, r) => t + (r.activeSeconds ?? 0), 0) : null);
const oldestFirst = (a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''));

const KINDS = { station: 'Station', merchant: 'Shop', admin: 'Admin' };

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
}

/** Who a set of one visitor's page views belongs to: the newest account they were logged in as. */
function identity(visitor, views) {
  const admin = views.some((v) => v.role === 'admin');
  const account = [...views].reverse().find((v) => v.role === 'station' || v.role === 'merchant');
  if (admin) return { kind: 'Admin', name: 'RADS10 admin', account: null };
  if (account) return { kind: KINDS[account.role], name: account.accountName ?? account.account ?? KINDS[account.role], account: account.account };
  return { kind: 'Visitor', name: `Visitor ${visitor.slice(0, 8)}`, account: null };
}

function isUsage(body) {
  return Boolean(body) && Array.isArray(body.views) && Array.isArray(body.clicks);
}

/** The usage endpoint's answer → what the RADS10 tab shows. */
export function fromRads10Usage(body, { includeAdmin = false } = {}) {
  const all = list(body.views)
    .filter((v) => clean(v.visitor) && clean(v.visit))
    .map((v) => ({
      at: v.at ?? null,
      visitor: clean(v.visitor),
      visit: clean(v.visit),
      path: clean(v.path) ?? '/',
      referrer: clean(v.referrer),
      station: clean(v.station),
      stationName: clean(v.stationName),
      role: clean(v.role),
      account: clean(v.account),
      accountName: clean(v.accountName),
      ip: clean(v.ip),
      ipAddress: normalizeIp(v.ip),
      device: clean(v.device),
      activeSeconds: duration(v.activeSeconds),
    }))
    .sort(oldestFirst);

  const admins = new Set(all.filter((v) => v.role === 'admin').map((v) => v.visitor));
  const views = includeAdmin ? all : all.filter((v) => !admins.has(v.visitor));
  const byVisitor = groupBy(views, 'visitor');
  const who = new Map([...byVisitor].map(([visitor, rows]) => [visitor, identity(visitor, rows)]));

  const visits = [...groupBy(views, 'visit')].map(([id, rows]) => {
    const first = rows[0];
    const placed = rows.find((r) => r.ipAddress) ?? first;
    return {
      id,
      personKey: first.visitor,
      ...who.get(first.visitor),
      startedAt: first.at,
      lastAt: rows.at(-1).at,
      pageViews: rows.length,
      pages: rows.map((r) => r.path),
      landing: first.path,
      referrer: first.referrer,
      station: rows.find((r) => r.station)?.station ?? null,
      stationName: rows.find((r) => r.stationName)?.stationName ?? null,
      activeSeconds: totalSeconds(rows),
      ip: placed.ip,
      ipAddress: placed.ipAddress,
      location: null, // the API stores no place; server/geo.js looks addresses up when the report runs
      device: rows.find((r) => r.device)?.device ?? null,
    };
  });

  const visitsOf = groupBy(visits, 'personKey');
  const visitors = [...byVisitor].map(([key, rows]) => {
    const own = visitsOf.get(key) ?? [];
    return {
      key,
      ...who.get(key),
      station: [...own].reverse().find((v) => v.station)?.station ?? null,
      visits: own.length,
      pageViews: rows.length,
      pages: distinct(rows.map((r) => r.path)),
      activeSeconds: totalSeconds(rows),
      firstSeen: rows[0].at,
      lastSeen: rows.at(-1).at,
      // Newest first, as the CEU Stamps tabs list a student's addresses.
      ipAddresses: distinct([...rows].reverse().map((r) => r.ipAddress)),
      locations: [],
      device: [...rows].reverse().find((r) => r.device)?.device ?? null,
    };
  });

  const pages = [...groupBy(views, 'path')].map(([path, rows]) => ({
    path,
    views: rows.length,
    visitors: new Set(rows.map((r) => r.visitor)).size,
    visits: new Set(rows.map((r) => r.visit)).size,
    activeSeconds: totalSeconds(rows),
    lastAt: rows.at(-1).at,
  }));

  const clicks = list(body.clicks).map((c) => ({
    slug: clean(c.slug) ?? '',
    shop: clean(c.shop) ?? clean(c.slug) ?? '',
    station: clean(c.station),
    stationName: clean(c.stationName),
    clicks: count(c.clicks),
    lastAt: c.lastAt ?? null,
  }));

  const accounts = visitors.filter((v) => v.kind === 'Station' || v.kind === 'Shop');
  return {
    site: 'rads10',
    source: 'api',
    range: { from: body.range?.from ?? null, to: body.range?.to ?? null },
    includeAdmin,
    adminHidden: includeAdmin ? 0 : admins.size,
    truncated: Boolean(body.truncated),
    generatedAt: new Date().toISOString(),
    totals: {
      visitors: visitors.length,
      accounts: new Set(accounts.map((v) => `${v.kind}:${v.account}`)).size,
      visits: visits.length,
      pageViews: views.length,
      activeSeconds: totalSeconds(views),
      clicks: clicks.reduce((t, c) => t + c.clicks, 0),
      shopsClicked: new Set(clicks.map((c) => c.slug)).size,
      locations: 0,
      placed: 0,
    },
    visitors,
    visits,
    pages,
    clicks,
  };
}

/**
 * City and state for each visit's address, looked up when the report runs
 * (server/geo.js), then each visitor's list of places and the Places tile.
 */
export async function fillVisitLocations(report, locate, { deadline = Date.now() + 3000, concurrency = 6 } = {}) {
  // Newest first, so if time runs out it is the oldest visits that go unplaced.
  const newest = [...report.visits].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  const wanted = distinct(newest.filter((v) => ipKind(v.ipAddress) === 'public').map((v) => v.ipAddress));
  const found = await lookUpAll(wanted, locate, { deadline, concurrency });

  for (const visit of report.visits) {
    if (found.has(visit.ipAddress)) {
      visit.location = found.get(visit.ipAddress);
      visit.locationLookedUp = true;
    }
  }
  const placesOf = new Map();
  for (const visit of newest) {
    if (!placesOf.has(visit.personKey)) placesOf.set(visit.personKey, []);
    placesOf.get(visit.personKey).push(visit.location);
  }
  for (const visitor of report.visitors) {
    visitor.locations = distinct(placesOf.get(visitor.key) ?? []);
    visitor.locationLookedUp = visitor.locations.length > 0;
  }
  report.totals.locations = new Set(report.visitors.flatMap((v) => v.locations)).size;
  report.totals.placed = report.visitors.filter((v) => v.locations.length).length;
  report.locationLookup = { addresses: wanted.length, placed: found.size };
  return report;
}

/** Status codes from the usage endpoint, turned into something an operator can act on. */
function failure(status, body, origin) {
  const message = clean(body?.error) ?? clean(body?.message);
  if (status === 404 && message === 'No such endpoint.') {
    return 'The API refused the admin key for the RADS10 report. It uses the same key as the CEU Stamps tab: ' +
      'check REPORT_API_KEY matches CEU_ADMIN_KEY on the ceustamps-api Web App.';
  }
  if (status === 404) {
    return `${origin} does not record RADS10 visits yet. In CEU-Website: apply the migration ` +
      '(deploy/apply-migration.ps1 013_rads10_visits.sql), then deploy the API (deploy/deploy-ceustamps.ps1), ' +
      'then publish the RADS10 site so its pages start reporting visits.';
  }
  if (status === 400) return `The API rejected the date range${message ? `: ${message}` : '.'}`;
  if (status === 429) return 'The API is rate-limiting this address. Wait a minute and retry.';
  return `The API answered ${status}${message ? `: ${message}` : '.'}`;
}

export function createRads10Source({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const endpoint = new URL('/api/rads10/admin/usage', url);

  return {
    /** `includeDemo` is the page's one checkbox; on this tab it reads "Include admin visits". */
    async report({ from, to, includeDemo = false }) {
      const target = new URL(endpoint);
      target.searchParams.set('from', from.toISOString());
      target.searchParams.set('to', to.toISOString());

      let response;
      try {
        response = await fetchImpl(target, {
          headers: { 'x-admin-key': key, accept: 'application/json' },
          // Never follow a redirect: fetch would carry x-admin-key to wherever it points.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`Could not reach the API at ${endpoint.origin}: ${err.cause?.message ?? err.message}`, { cause: err });
      }

      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(failure(response.status, body, endpoint.origin));
      if (!isUsage(body)) throw new Error('The API answered, but not with a RADS10 usage report.');
      return fromRads10Usage(body, { includeAdmin: includeDemo });
    },
    async close() {},
  };
}
