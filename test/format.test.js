import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  csvField, emptyLocationLabel, formatSeat, ipDisplay, ipKind, joinLocation, localDayWindow, locationDisplay,
  normalizeIp, toCsv,
} from '../shared/format.js';

test('strips a port from IPv4 and bracketed IPv6, never from plain IPv6 (§5.8)', () => {
  assert.equal(normalizeIp('98.122.179.148:61347'), '98.122.179.148');
  assert.equal(normalizeIp('::ffff:98.122.179.148:61347'), '::ffff:98.122.179.148');
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeIp('2001:db8::1:443'), '2001:db8::1:443');
  assert.equal(normalizeIp(' 98.122.179.148 '), '98.122.179.148');
  assert.equal(normalizeIp(''), null);
  assert.equal(normalizeIp(null), null);
});

test('classifies addresses (§5.7)', () => {
  for (const ip of ['::1', '::ffff:127.0.0.1', '127.0.0.1', '127.8.8.8:5000']) assert.equal(ipKind(ip), 'loopback', ip);
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.255', '169.254.1.1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(ipKind(ip), 'private', ip);
  }
  for (const ip of ['172.15.0.1', '172.32.0.1', '98.122.179.148', '2001:db8::1', 'fd1::1']) assert.equal(ipKind(ip), 'public', ip);
  assert.equal(ipKind(null), 'none');
});

test('ip display', () => {
  assert.equal(ipDisplay('::1'), 'this machine');
  assert.equal(ipDisplay('192.168.1.4'), 'local network');
  assert.equal(ipDisplay('98.122.179.148:61347'), '98.122.179.148');
  assert.equal(ipDisplay(null), '—');
});

test('location and its three empty cases (§5.6)', () => {
  assert.equal(joinLocation('Concord', 'North Carolina', 'United States'), 'Concord, North Carolina, United States');
  assert.equal(joinLocation(null, ' ', 'United States'), 'United States');
  assert.equal(joinLocation(null, null, null), null);
  assert.equal(locationDisplay('Concord', '1.2.3.4'), 'Concord');
  assert.equal(locationDisplay(null, null), '—');
  assert.equal(locationDisplay(null, '10.0.0.1'), 'no public address');
  assert.equal(locationDisplay(null, '::1'), 'no public address');
  assert.equal(locationDisplay(null, '203.0.113.5'), 'not resolved');
  assert.equal(emptyLocationLabel(['10.0.0.1', '203.0.113.5']), 'not resolved');
  assert.equal(emptyLocationLabel([]), '—');
});

test('seat time', () => {
  assert.equal(formatSeat(0), '0h 0m');
  assert.equal(formatSeat(125), '2h 5m');
});

test('csv quoting and formula guard (§6.6)', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('Concord, NC'), '"Concord, NC"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(0), '0');
  assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvField('+cmd|x'), "'+cmd|x");
  assert.equal(csvField('+1 (704) 555-0100'), '+1 (704) 555-0100');
  assert.equal(csvField(-5), '-5');
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
});

test('date window is built on the viewer clock (§5.1)', () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    assert.deepEqual(localDayWindow('2026-09-01', '2026-09-09'), {
      from: '2026-09-01T07:00:00.000Z',
      to: '2026-09-10T07:00:00.000Z',
    });
    process.env.TZ = 'Asia/Kolkata';
    assert.deepEqual(localDayWindow('2026-09-10', '2026-09-10'), {
      from: '2026-09-09T18:30:00.000Z',
      to: '2026-09-10T18:30:00.000Z',
    });
    assert.equal(localDayWindow('', '2026-09-10'), null);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});
