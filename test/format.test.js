import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  csvField, deviceSummary, emptyLocationLabel, formatDuration, formatSeat, ipDisplay, ipKind, joinLocation,
  localDayWindow, locationDisplay, normalizeIp, toCsv,
} from '../shared/format.js';

test('time on site reads as a short duration, and unrecorded stays unrecorded', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(60), '1m 0s');
  assert.equal(formatDuration(725), '12m 5s');
  assert.equal(formatDuration(3840), '1h 4m');
  assert.equal(formatDuration(-3), '0s');
});

test('device summary names the browser and system', () => {
  const cases = {
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36': 'Chrome on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0': 'Edge on Windows',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1': 'Safari on iPhone',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15': 'Safari on Mac',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36': 'Chrome on Android',
    'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0': 'Firefox on Linux',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0 Mobile/15E148 Safari/604.1': 'Chrome on iPhone',
    'node': 'node',
  };
  for (const [ua, expected] of Object.entries(cases)) assert.equal(deviceSummary(ua), expected, ua);
  assert.equal(deviceSummary(null), null);
  assert.equal(deviceSummary('  '), null);
  assert.equal(deviceSummary('x'.repeat(60)), `${'x'.repeat(40)}…`);
});

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
