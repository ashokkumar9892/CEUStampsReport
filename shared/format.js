// Rules shared by the server (grouping) and the page (display and CSV).
// Section numbers refer to docs/report-requirements.md.

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** §5.8 — strip the source port that rows written before 9 Sep 2026 carry. */
export function normalizeIp(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];
  const v4WithPort = /^((?:::ffff:)?\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/i.exec(value);
  if (v4WithPort) return v4WithPort[1];
  // A plain IPv6 address is left alone: its last group only looks like a port.
  return value;
}

/** §5.7 — 'none' | 'loopback' | 'private' | 'public'. */
export function ipKind(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return 'none';
  let v = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) v = mapped[1];
  if (v === '::1' || v.startsWith('127.')) return 'loopback';
  if (IPV4.test(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
      return 'private';
    }
    return 'public';
  }
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v)) return 'private';
  return 'public';
}

/** §5.7 — what the grid shows for an address. The CSV exports the stored value instead. */
export function ipDisplay(raw) {
  switch (ipKind(raw)) {
    case 'none': return '—';
    case 'loopback': return 'this machine';
    case 'private': return 'local network';
    default: return normalizeIp(raw);
  }
}

/** §5.6 — "city, region, country", skipping blanks; null when all are blank. */
export function joinLocation(city, region, country) {
  const parts = [city, region, country].map((p) => (p == null ? '' : String(p).trim())).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** §5.6 — why there is no location, given the addresses the rows came from. */
export function emptyLocationLabel(ips) {
  const kinds = ips.map(ipKind).filter((k) => k !== 'none');
  if (!kinds.length) return '—';
  return kinds.includes('public') ? 'not resolved' : 'no public address';
}

export function locationDisplay(location, ip) {
  return location || emptyLocationLabel([ip]);
}

/**
 * A browser's user-agent string as "Chrome on Windows". Returns null when there is
 * none; the page shows the full string on hover, and the CSV exports it untouched.
 */
export function deviceSummary(userAgent) {
  const ua = userAgent == null ? '' : String(userAgent).trim();
  if (!ua) return null;
  // Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari".
  const browser =
    /\bEdgA?\//.test(ua) ? 'Edge'
      : /\b(OPR|Opera)\//.test(ua) ? 'Opera'
        : /\bSamsungBrowser\//.test(ua) ? 'Samsung Internet'
          : /\b(Firefox|FxiOS)\//.test(ua) ? 'Firefox'
            : /\b(Chrome|CriOS)\//.test(ua) ? 'Chrome'
              : /\bVersion\/[\d.]+.*\bSafari\//.test(ua) ? 'Safari'
                : null;
  const os =
    /\b(iPhone|iPod)\b/.test(ua) ? 'iPhone'
      : /\biPad\b/.test(ua) ? 'iPad'
        : /\bAndroid\b/.test(ua) ? 'Android'
          : /\bWindows\b/.test(ua) ? 'Windows'
            : /\bCrOS\b/.test(ua) ? 'ChromeOS'
              : /\bMac OS X\b/.test(ua) ? 'Mac'
                : /\bLinux\b/.test(ua) ? 'Linux'
                  : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser || os) return browser ?? os;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

/**
 * Seconds as a short duration: "45s", "12m 5s", "1h 4m". Null stays null —
 * a visit whose time was never recorded is not a visit of zero seconds.
 */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Minutes as "Xh Ym". */
export function formatSeat(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * §6.6 — one CSV field. Quotes fields containing a comma, quote or newline.
 * Sign-ins are typed by the public, so a value that a spreadsheet would run as a
 * formula gets a leading apostrophe. Phone-like values ("+1 (555) 010-2000") are left alone.
 */
export function csvField(value) {
  if (value == null) return '';
  let s = String(value);
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().+-]*$)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** YYYY-MM-DD for a Date, on the viewer's clock. */
export function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localMidnight(day, plusDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * §5.1 — the half-open UTC window for calendar days picked on the viewer's clock:
 * local midnight starting the From day, to local midnight starting the day after To.
 */
export function localDayWindow(fromDay, toDay) {
  const from = localMidnight(fromDay, 0);
  const to = localMidnight(toDay, 1);
  if (!from || !to) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}
