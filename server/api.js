// Reads the report from the live API instead of the database
// (docs/report-requirements.md §9, in the CEU-Website repo). The API applies the
// §5 rules itself; this only reshapes its answer for the page. The admin key
// stays here on the server and is never sent to the browser (§9.4).

import { normalizeIp } from '../shared/format.js';
import { describeResult, NO_NAME } from './report.js';

const list = (v) => (Array.isArray(v) ? v : []);
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const distinct = (values) => [...new Set(values.filter(Boolean))];
// Addresses come back raw, so the §5.8 port quirk still applies before grouping.
const addresses = (values) => distinct(list(values).map(normalizeIp));
const count = (v) => Number(v) || 0;

function isReport(body) {
  return Boolean(body) && typeof body.totals === 'object' &&
    ['students', 'courses', 'sessions', 'signIns'].every((key) => Array.isArray(body[key]));
}

/** §9.3 response → the shape server/report.js builds from database rows. */
export function fromApiReport(body) {
  const sittings = list(body.sessions).map((s) => ({
    id: String(s.id),
    personKey: clean(s.licence) ?? '',
    license: clean(s.licence),
    name: clean(s.name) ?? NO_NAME,
    email: clean(s.email),
    phone: clean(s.phone),
    state: clean(s.state),
    courseId: clean(s.courseId),
    course: clean(s.course) ?? clean(s.courseId) ?? '',
    startedAt: s.startedAt ?? null,
    completedAt: s.completedAt ?? null,
    result: describeResult(s.completedAt, s.passed, s.scorePercent),
    passed: s.passed == null ? null : Boolean(s.passed),
    score: s.scorePercent ?? null,
    seatMinutes: count(s.seatMinutes),
    certificate: clean(s.certificate),
    ip: clean(s.ip),
    ipAddress: normalizeIp(s.ip),
    location: clean(s.location),
    device: clean(s.device),
    isDemo: Boolean(s.isDemo),
  }));

  const signIns = list(body.signIns).map((v, i) => ({
    id: `sign-in-${i + 1}`, // the API does not return sign-in ids
    at: v.at ?? null,
    personKey: clean(v.licence) ?? '',
    license: clean(v.licence),
    name: clean(v.name) ?? NO_NAME,
    email: clean(v.email),
    phone: clean(v.phone),
    state: clean(v.state),
    ip: clean(v.ip),
    ipAddress: normalizeIp(v.ip),
    location: clean(v.location),
    device: clean(v.device),
  }));

  const students = list(body.students).map((p) => ({
    key: clean(p.licence) ?? '',
    name: clean(p.name) ?? NO_NAME,
    email: clean(p.email),
    phone: clean(p.phone),
    state: clean(p.state),
    courses: distinct(list(p.courses).map(clean)),
    signIns: count(p.signIns),
    sittings: count(p.sessions),
    finished: count(p.completed),
    seatMinutes: count(p.seatMinutes),
    averageScore: p.averageScore ?? null,
    firstSeen: p.firstSeen ?? null,
    lastSeen: p.lastSeen ?? null,
    ipAddresses: addresses(p.addresses),
    locations: distinct(list(p.locations).map(clean)),
  }));

  // "N passed" is shown only for courses with graded sittings; the API does not
  // count those per course, but its sittings say which ones were graded.
  const graded = new Map();
  for (const s of sittings) {
    if (s.passed != null) graded.set(s.courseId, (graded.get(s.courseId) ?? 0) + 1);
  }

  const courses = list(body.courses).map((c) => ({
    id: clean(c.id) ?? clean(c.title),
    course: clean(c.title) ?? clean(c.id) ?? '',
    state: clean(c.state),
    students: count(c.students),
    sittings: count(c.sessions),
    finished: count(c.completed),
    graded: graded.get(clean(c.id)) ?? 0,
    passed: count(c.passed),
    averageScore: c.averageScore ?? null,
    seatMinutes: count(c.seatMinutes),
    ipAddresses: addresses(c.addresses),
    locations: distinct(list(c.locations).map(clean)),
  }));

  const t = body.totals;
  return {
    source: 'api',
    range: { from: body.range?.from ?? null, to: body.range?.to ?? null },
    includeDemo: Boolean(body.range?.includeDemo),
    demoHidden: null, // the API does not say how many demo sittings it left out
    geoipConfigured: typeof body.geoipConfigured === 'boolean' ? body.geoipConfigured : null,
    generatedAt: new Date().toISOString(),
    totals: {
      people: count(t.students),
      signedInOnly: count(t.signedInOnly),
      signIns: count(t.signIns),
      sittings: count(t.sessions),
      finished: count(t.completed),
      certificates: count(t.certificates),
      seatMinutes: count(t.seatMinutes),
      locations: count(t.locationsResolved),
    },
    students,
    courses,
    sittings,
    signIns,
  };
}

/** §9.2 status codes, turned into something an operator can act on. */
function failure(status, body, origin) {
  const message = clean(body?.message);
  if (status === 404 && message) {
    return 'The API refused the admin key (it answers "No such endpoint." to a missing or wrong key). ' +
      'Check REPORT_API_KEY matches CEU_ADMIN_KEY on the ceustamps-api Web App.';
  }
  if (status === 404) {
    return `${origin} has no report endpoint yet — the deployed API predates it. ` +
      'Deploy the current API (deploy/deploy-ceustamps.ps1 in CEU-Website) and set CEU_ADMIN_KEY, then retry.';
  }
  if (status === 400) return `The API rejected the date range${message ? `: ${message}` : '.'}`;
  if (status === 429) return 'The API is rate-limiting this address (120 requests a minute). Wait a minute and retry.';
  return `The API answered ${status}${message ? `: ${message}` : '.'}`;
}

export function createApiSource({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const endpoint = new URL('/api/admin/report', url);

  return {
    async report({ from, to, includeDemo = false }) {
      const target = new URL(endpoint);
      // Exact instants, so the API uses the window built on the viewer's clock (§5.1)
      // rather than reading bare dates as UTC days.
      target.searchParams.set('from', from.toISOString());
      target.searchParams.set('to', to.toISOString());
      if (includeDemo) target.searchParams.set('demo', '1');

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
      if (!isReport(body)) throw new Error('The API answered, but not with a report.');
      return fromApiReport(body);
    },
    async close() {},
  };
}
