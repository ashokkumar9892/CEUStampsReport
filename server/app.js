// HTTP handler: the page, its scripts, and GET /api/report. Nothing else is served.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = 'text/javascript; charset=utf-8';

// An explicit list, so no request path can reach any other file on disk.
const FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', JS]],
  ['/shared/format.js', ['shared/format.js', JS]],
  ['/shared/table.js', ['shared/table.js', JS]],
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];
const LOOPBACK_ADDRESS = /^(?:127\.|::1$|::ffff:127\.)/;
// Guards against DNS rebinding: a hostile site pointing its own name at 127.0.0.1.
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

function send(res, status, body, headers = {}, headOnly = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(headOnly ? undefined : buf);
}

const sendText = (res, status, text, headers = {}) =>
  send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
const sendJson = (res, status, value) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });

function parseInstant(value) {
  if (!value || !INSTANT.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param source anything with report({ from, to, includeDemo }) — the live API
 *               (server/api.js) or the database (server/db.js).
 */
export function createApp({ config, source, log = console }) {
  const expected = config.auth ? digest(`${config.auth.user}:${config.auth.password}`) : null;

  function refusal(req) {
    if (!config.local) return null;
    if (!LOOPBACK_ADDRESS.test(req.socket.remoteAddress ?? '')) return 'This report only opens on the machine it runs on.';
    if (PROXY_HEADERS.some((h) => h in req.headers)) return 'Requests that came through a proxy are refused.';
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return 'Open the report at http://localhost or http://127.0.0.1.';
    return null;
  }

  function authorised(req) {
    if (!expected) return true;
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '');
    return Boolean(m) && timingSafeEqual(digest(Buffer.from(m[1], 'base64').toString('utf8')), expected);
  }

  async function report(url, res) {
    const from = parseInstant(url.searchParams.get('from'));
    const to = parseInstant(url.searchParams.get('to'));
    if (!from || !to) {
      return sendJson(res, 400, { error: 'from and to must be UTC timestamps, e.g. 2026-09-01T07:00:00.000Z.' });
    }
    if (to <= from) return sendJson(res, 400, { error: 'The end of the range must be after its start.' });
    const includeDemo = url.searchParams.get('includeDemo') === '1';

    let body;
    try {
      body = await source.report({ from, to, includeDemo });
    } catch (err) {
      log.error('Report failed:', err);
      return sendJson(res, 502, { error: err.message || 'The report could not be loaded.' });
    }
    return sendJson(res, 200, body);
  }

  return async function handle(req, res) {
    try {
      const refused = refusal(req);
      if (refused) return sendText(res, 403, refused);
      if (!authorised(req)) {
        return sendText(res, 401, 'Sign in to view the report.', {
          'WWW-Authenticate': 'Basic realm="CEU Stamps report", charset="UTF-8"',
        });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });

      const url = new URL(req.url ?? '/', 'http://report.invalid');
      if (url.pathname === '/api/report') return await report(url, res);

      const file = FILES.get(url.pathname);
      if (!file) return sendText(res, 404, 'Not found.');
      const body = await readFile(path.join(ROOT, file[0]));
      return send(res, 200, body, { 'Content-Type': file[1] }, req.method === 'HEAD');
    } catch (err) {
      log.error(err);
      if (res.headersSent) res.destroy();
      else sendText(res, 500, 'Internal error.');
    }
  };
}
