// City and state for addresses the API never placed (§5.6).
//
// The CEU Stamps API can resolve an address when a visit is recorded, but that
// is switched off there, so every row arrives with no location. This fills the
// gap when the report runs: each public address with no location is looked up
// at a free service, and the answer is shown in place of "not resolved".
//
// The owner asked for this on 15 Sep 2026. It sends visitors' IP addresses to a
// third party (§7.5) — only public ones: loopback and private addresses are
// never sent, and nothing is sent at all when REPORT_GEOIP=off.
//
// Best effort throughout. A slow, down or rate-limited service leaves the row
// as it was; the report is never held past its deadline or failed because of it.

import { ipKind, joinLocation } from '../shared/format.js';

/** Free, keyless, HTTPS providers, tried in order until one places the address. */
export const PROVIDERS = [
  {
    name: 'ipwho.is',
    url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,message,city,region,country`,
    place: (body) => (body?.success === true ? joinLocation(body.city, body.region, body.country) : undefined),
  },
  {
    // About 1,000 lookups a day without a key.
    name: 'db-ip.com',
    url: (ip) => `https://api.db-ip.com/v2/free/${encodeURIComponent(ip)}`,
    place: (body) => (body && !body.error && !body.errorCode ? joinLocation(body.city, body.stateProv, body.countryName) : undefined),
  },
];

const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000; // addresses rarely move; a week keeps the free quotas untouched
const MISSED_TTL_MS = 30 * 60 * 1000; // try an unplaced address again later, not on every run

/**
 * A lookup with a memory. Returns the location string, or null when no provider
 * could place the address (including every private or loopback address).
 *
 * `undefined` from a provider means "no answer" (failed, limited, timed out), and
 * the next provider is tried; `null` means it answered but had no place for it.
 *
 * The default fetch is looked up on each call rather than captured at import, so
 * a replaced global fetch (as in the tests) is the one used.
 */
export function createLocator({ providers = PROVIDERS, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now() } = {}) {
  const cache = new Map(); // ip -> { location, until }

  return async function locate(ip, { timeoutMs = 2500 } = {}) {
    if (ipKind(ip) !== 'public') return null;
    const hit = cache.get(ip);
    if (hit && hit.until > now()) return hit.location;

    for (const provider of providers) {
      let body;
      try {
        const response = await fetchImpl(provider.url(ip), {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        });
        if (!response.ok) continue;
        body = await response.json();
      } catch {
        continue;
      }
      const location = provider.place(body);
      if (location) {
        cache.set(ip, { location, until: now() + FOUND_TTL_MS });
        return location;
      }
    }
    cache.set(ip, { location: null, until: now() + MISSED_TTL_MS });
    return null;
  };
}

async function eachLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const newestFirst = (rows, key) => [...rows].sort((a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')));
const distinct = (values) => [...new Set(values.filter(Boolean))];

/**
 * Fills in looked-up locations on a built report (the shape server/report.js
 * and server/api.js produce), then brings every figure that counts locations
 * back into line: each person's and course's list, and the Locations tile.
 *
 * Rows that already have a location are left exactly as they are.
 */
export async function fillLocations(report, locate, { deadline = Date.now() + 3000, concurrency = 6 } = {}) {
  const rows = [...report.sittings, ...report.signIns];
  const wanted = distinct(rows.filter((r) => !r.location && ipKind(r.ipAddress) === 'public').map((r) => r.ipAddress));

  const found = new Map();
  await eachLimited(wanted, concurrency, async (ip) => {
    const left = deadline - Date.now();
    if (left < 200) return; // out of time: leave it unresolved rather than hold the report
    const location = await locate(ip, { timeoutMs: left });
    if (location) found.set(ip, location);
  });

  for (const row of rows) {
    if (!row.location && found.has(row.ipAddress)) {
      row.location = found.get(row.ipAddress);
      row.locationLookedUp = true;
    }
  }

  const visitsOf = new Map();
  for (const s of report.sittings) {
    if (!visitsOf.has(s.personKey)) visitsOf.set(s.personKey, []);
    visitsOf.get(s.personKey).push({ at: s.startedAt, location: s.location });
  }
  for (const v of report.signIns) {
    if (!visitsOf.has(v.personKey)) visitsOf.set(v.personKey, []);
    visitsOf.get(v.personKey).push({ at: v.at, location: v.location });
  }
  for (const student of report.students) {
    const visits = visitsOf.get(student.key) ?? [];
    student.locations = distinct([...student.locations, ...newestFirst(visits, 'at').map((v) => v.location)]);
  }
  for (const course of report.courses) {
    const sittings = report.sittings.filter((s) => (s.courseId ?? s.course) === course.id);
    course.locations = distinct([...course.locations, ...newestFirst(sittings, 'startedAt').map((s) => s.location)]);
  }

  report.totals.locations =
    report.sittings.filter((s) => s.location).length + report.signIns.filter((v) => v.location).length;
  report.geoipConfigured = true;
  report.locationLookup = { addresses: wanted.length, placed: found.size };
  return report;
}

/**
 * Wraps a report source so its reports come back with locations filled in.
 * `budgetMs` is how long, from the start of the request, the whole thing may take.
 */
export function withLocations(source, locate, { budgetMs = 8500 } = {}) {
  return {
    async report(args) {
      const started = Date.now();
      const report = await source.report(args);
      return fillLocations(report, locate, { deadline: started + budgetMs });
    },
    close: () => source.close?.(),
  };
}
