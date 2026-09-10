// Turns the rows from the two report queries into the report (§5, §6.2, §6.3).

import { joinLocation, normalizeIp } from '../shared/format.js';

export const NO_NAME = '(no name given)';

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
const distinct = (values) => [...new Set(values.filter(Boolean))];
const sum = (values) => values.reduce((a, b) => a + b, 0);
const newestFirst = (items, key) => [...items].sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
const oldestFirst = (items, key) => newestFirst(items, key).reverse();

function average(values) {
  const present = values.filter((v) => v != null);
  return present.length ? Math.round(sum(present) / present.length) : null;
}

function fullName(first, last) {
  return [clean(first), clean(last)].filter(Boolean).join(' ') || null;
}

/** §5.2 — a person is their licence number. */
export const personKey = (license) => (clean(license) ?? '').toUpperCase();

/** §5.4 */
export function courseLabel(row) {
  const program = clean(row.program_title);
  if (program && row.section_number != null) return `${program} — Section ${row.section_number}`;
  return clean(row.course_title) ?? clean(row.course_id) ?? '';
}

/** §5.5 — completion-row seat time wins over the session's running total. */
export function seatMinutes(row) {
  return Math.round((row.seat_seconds ?? row.credited_seconds ?? 0) / 60);
}

/** §5.5 — no completion row (passed is null) means a single-sitting course. */
export function describeResult(completedAt, passed, score) {
  if (completedAt == null) return 'in progress';
  if (passed == null) return 'finished';
  if (!passed) return 'fail';
  return score == null ? 'pass' : `${score}% pass`;
}

export const resultOf = (row) => describeResult(row.completed_at, row.passed, row.score_percent);

function toSitting(r) {
  return {
    id: String(r.session_id),
    personKey: personKey(r.license_number),
    license: clean(r.license_number),
    name: fullName(r.first_name, r.last_name) ?? NO_NAME,
    email: clean(r.email),
    phone: clean(r.phone),
    state: clean(r.state_code),
    courseId: clean(r.course_id),
    course: courseLabel(r),
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    result: resultOf(r),
    passed: r.passed == null ? null : Boolean(r.passed),
    score: r.score_percent ?? null,
    seatMinutes: seatMinutes(r),
    certificate: clean(r.certificate_number),
    ip: clean(r.created_ip), // as stored — the CSV exports this
    ipAddress: normalizeIp(r.created_ip), // port stripped — for display and grouping
    location: joinLocation(r.created_city, r.created_region, r.created_country),
    device: clean(r.user_agent),
    isDemo: Boolean(r.is_demo),
  };
}

function toSignIn(r) {
  return {
    id: String(r.id),
    at: iso(r.at),
    personKey: personKey(r.license_number),
    license: clean(r.license_number),
    name: fullName(r.first_name, r.last_name) ?? NO_NAME,
    email: clean(r.email),
    phone: clean(r.phone),
    state: clean(r.state_code),
    ip: clean(r.created_ip),
    ipAddress: normalizeIp(r.created_ip),
    location: joinLocation(r.created_city, r.created_region, r.created_country),
    device: clean(r.user_agent),
  };
}

function buildStudents(sittings, signIns) {
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { sittings: [], signIns: [] });
    return groups.get(key);
  };
  for (const s of sittings) group(s.personKey).sittings.push(s);
  for (const v of signIns) group(v.personKey).signIns.push(v);

  return [...groups].map(([key, g]) => {
    const recentSittings = newestFirst(g.sittings, 'startedAt');
    const earlyVisits = oldestFirst(g.signIns, 'at');
    // Checked details from a sitting win; otherwise the first sign-in that has one.
    const pick = (field) =>
      recentSittings.find((s) => s[field])?.[field] ?? earlyVisits.find((v) => v[field])?.[field] ?? null;
    const name = recentSittings[0]?.name ?? earlyVisits.find((v) => v.name !== NO_NAME)?.name ?? NO_NAME;
    const visits = newestFirst(
      [
        ...g.sittings.map((s) => ({ at: s.startedAt, ip: s.ipAddress, location: s.location })),
        ...g.signIns.map((v) => ({ at: v.at, ip: v.ipAddress, location: v.location })),
      ],
      'at',
    );
    return {
      key,
      name,
      email: pick('email'),
      phone: pick('phone'),
      state: pick('state'),
      courses: distinct(g.sittings.map((s) => s.course)).sort(byText),
      signIns: g.signIns.length,
      sittings: g.sittings.length,
      finished: g.sittings.filter((s) => s.completedAt).length,
      seatMinutes: sum(g.sittings.map((s) => s.seatMinutes)),
      averageScore: average(g.sittings.map((s) => s.score)),
      firstSeen: visits.at(-1)?.at ?? null,
      lastSeen: visits[0]?.at ?? null,
      // Most recent first, so "first address" in the grid is the latest one.
      ipAddresses: distinct(visits.map((v) => v.ip)),
      locations: distinct(visits.map((v) => v.location)),
    };
  });
}

function buildCourses(sittings) {
  const groups = new Map();
  for (const s of sittings) {
    const id = s.courseId ?? s.course;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(s);
  }
  return [...groups].map(([id, list]) => {
    const recent = newestFirst(list, 'startedAt');
    return {
      id,
      course: list[0].course,
      state: distinct(list.map((s) => s.state)).sort().join(', ') || null,
      students: new Set(list.map((s) => s.personKey)).size,
      sittings: list.length,
      finished: list.filter((s) => s.completedAt).length,
      graded: list.filter((s) => s.passed != null).length,
      passed: list.filter((s) => s.passed === true).length,
      averageScore: average(list.map((s) => s.score)),
      seatMinutes: sum(list.map((s) => s.seatMinutes)),
      ipAddresses: distinct(recent.map((s) => s.ipAddress)),
      locations: distinct(recent.map((s) => s.location)),
    };
  });
}

/**
 * @param sessionRows rows from the sittings query (§4.1)
 * @param signInRows  rows from the sign-ins query (§4.2)
 */
export function buildReport(sessionRows, signInRows, { from, to, includeDemo = false } = {}) {
  // One row per session even if a join ever fans out.
  const byId = new Map();
  for (const row of sessionRows) {
    const id = String(row.session_id);
    if (!byId.has(id)) byId.set(id, toSitting(row));
  }
  const all = [...byId.values()];
  const sittings = includeDemo ? all : all.filter((s) => !s.isDemo); // §5.3
  const signIns = signInRows.map(toSignIn);
  const students = buildStudents(sittings, signIns);
  const finished = sittings.filter((s) => s.completedAt);

  return {
    source: 'database',
    range: { from: iso(from), to: iso(to) },
    includeDemo,
    demoHidden: all.length - sittings.length,
    geoipConfigured: null, // not knowable from the database
    generatedAt: new Date().toISOString(),
    totals: {
      people: students.length,
      signedInOnly: students.filter((p) => p.sittings === 0).length,
      signIns: signIns.length,
      sittings: sittings.length,
      finished: finished.length,
      certificates: finished.filter((s) => s.certificate).length,
      seatMinutes: sum(sittings.map((s) => s.seatMinutes)),
      locations: sittings.filter((s) => s.location).length + signIns.filter((v) => v.location).length,
    },
    students,
    courses: buildCourses(sittings),
    sittings,
    signIns,
  };
}
