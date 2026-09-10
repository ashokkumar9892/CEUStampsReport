import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, courseLabel, NO_NAME, resultOf, seatMinutes } from '../server/report.js';
import { sessionRows, signInRows } from './fixtures.js';

const report = buildReport(sessionRows, signInRows, {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-09-11T00:00:00Z'),
});
const student = (key) => report.students.find((s) => s.key === key);
const sitting = (id) => report.sittings.find((s) => s.id === id);

test('tiles', () => {
  assert.deepEqual(report.totals, {
    people: 6, // Pat, Jordan, Sam, Ava, Vic, Chris — the demo student is hidden
    signedInOnly: 1, // Chris
    signIns: 4,
    sittings: 6,
    finished: 4, // S1, S3, S4, S5
    certificates: 1,
    seatMinutes: 30 + 13 + 60 + 25 + 60 + 0,
    locations: 2 + 1, // S1, S2 + Pat's sign-in
  });
  assert.equal(report.demoHidden, 1);
  assert.equal(report.range.from, '2026-09-01T00:00:00.000Z');
});

test('demo sittings are included on request', () => {
  const withDemo = buildReport(sessionRows, signInRows, { includeDemo: true });
  assert.equal(withDemo.totals.sittings, 7);
  assert.equal(withDemo.totals.people, 7);
  assert.equal(withDemo.demoHidden, 0);
});

test('a person is their trimmed, upper-cased licence across sittings and sign-ins', () => {
  const pat = student('NC-12345');
  assert.equal(pat.sittings, 2);
  assert.equal(pat.signIns, 1);
  assert.equal(pat.finished, 1);
  assert.equal(pat.seatMinutes, 43);
  assert.equal(pat.averageScore, 90);
  assert.deepEqual(pat.courses, ['NC Electrical 4h — Section 1', 'NC Electrical 4h — Section 2']);
  assert.equal(pat.firstSeen, '2026-09-01T12:00:00.000Z');
  assert.equal(pat.lastSeen, '2026-09-03T15:00:00.000Z');
  assert.deepEqual(pat.ipAddresses, ['98.122.179.148'], 'port stripped before grouping');
  assert.deepEqual(pat.locations, ['Concord, North Carolina, United States']);
});

test('checked details from sittings win over sign-ins', () => {
  const pat = student('NC-12345');
  assert.equal(pat.name, 'Pat Rivera');
  assert.equal(pat.email, 'pat@new.example', 'most recent sitting');
  assert.equal(pat.phone, '+1 704 555 0100', 'falls back to an earlier sitting');
  assert.equal(pat.state, 'NC');
});

test('sign-in-only people take the first sign-in that has each field', () => {
  const chris = student('TX-9');
  assert.equal(chris.name, 'Chris Doe');
  assert.equal(chris.email, 'chris@example.com');
  assert.equal(chris.state, 'TX');
  assert.deepEqual(chris.courses, []);
  assert.equal(chris.signIns, 2);
  assert.equal(report.signIns.find((v) => v.id === 'G2').name, NO_NAME);
});

test('courses group sittings and deduplicate places', () => {
  const s3 = report.courses.find((c) => c.id === 'nc-elec-4h-s3');
  assert.equal(s3.course, 'NC Electrical 4h — Section 3');
  assert.equal(s3.graded, 1);
  assert.equal(s3.passed, 0);
  assert.equal(s3.averageScore, 60);
  const legacy = report.courses.find((c) => c.id === 'legacy-course');
  assert.equal(legacy.course, 'legacy-course');
  assert.equal(report.courses.length, 6);
});

test('sittings keep the stored address for the CSV and the stripped one for display', () => {
  assert.equal(sitting('S1').ip, '98.122.179.148:61347');
  assert.equal(sitting('S1').ipAddress, '98.122.179.148');
  assert.equal(sitting('S6').ip, null);
  assert.equal(sitting('S3').state, 'SC');
});

test('course label (§5.4)', () => {
  assert.equal(courseLabel({ program_title: 'P', section_number: 2, course_title: 'T', course_id: 'id' }), 'P — Section 2');
  assert.equal(courseLabel({ program_title: 'P', section_number: null, course_title: 'T', course_id: 'id' }), 'T');
  assert.equal(courseLabel({ course_title: null, course_id: 'id' }), 'id');
});

test('result and seat time (§5.5)', () => {
  assert.equal(resultOf({ completed_at: null, passed: true }), 'in progress');
  assert.equal(resultOf({ completed_at: new Date(), passed: null }), 'finished');
  assert.equal(resultOf({ completed_at: new Date(), passed: true, score_percent: 85 }), '85% pass');
  assert.equal(resultOf({ completed_at: new Date(), passed: false, score_percent: 40 }), 'fail');
  assert.equal(seatMinutes({ seat_seconds: 1800, credited_seconds: 9999 }), 30);
  assert.equal(seatMinutes({ seat_seconds: null, credited_seconds: 90 }), 2);
  assert.equal(seatMinutes({ seat_seconds: null, credited_seconds: null }), 0);
});

test('a join that fans out does not double-count a sitting', () => {
  const doubled = buildReport([...sessionRows, { ...sessionRows[0], certificate_number: 'DUP' }], []);
  assert.equal(doubled.totals.sittings, 6);
});
