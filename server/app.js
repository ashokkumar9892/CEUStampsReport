// HTTP handler for running the report as a Node server (npm start): the page,
// its scripts, and GET /api/report. Nothing else is served.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerReport, basicAuthOk, SECURITY_HEADERS, UNAUTHORISED_HEADERS } from './endpoint.js';

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

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];
const LOOPBACK_ADDRESS = /^(?:127\.|::1$|::ffff:127\.)/;
// Guards against DNS rebinding: a hostile site pointing its own name at 127.0.0.1.
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function send(res, status, body, headers = {}, headOnly = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(headOnly ? undefined : buf);
}

const sendText = (res, status, text, headers = {}) =>
  send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
const sendJson = (res, status, value) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });

/**
 * @param source anything with report({ from, to, includeDemo }) — the live API
 *               (server/api.js) or the database (server/db.js) — or one per
 *               tab of the page: { ceu, rads10 }.
 */
export function createApp({ config, source, log = console }) {
  function refusal(req) {
    if (!config.local) return null;
    if (!LOOPBACK_ADDRESS.test(req.socket.remoteAddress ?? '')) return 'This report only opens on the machine it runs on.';
    if (PROXY_HEADERS.some((h) => h in req.headers)) return 'Requests that came through a proxy are refused.';
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return 'Open the report at http://localhost or http://127.0.0.1.';
    return null;
  }

  return async function handle(req, res) {
    try {
      const refused = refusal(req);
      if (refused) return sendText(res, 403, refused);
      if (config.auth && !basicAuthOk(req.headers.authorization, config.auth)) {
        return sendText(res, 401, 'Sign in to view the report.', UNAUTHORISED_HEADERS);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });

      const url = new URL(req.url ?? '/', 'http://report.invalid');
      if (url.pathname === '/api/report') {
        const { status, body } = await answerReport(url.searchParams, source, log);
        return sendJson(res, status, body);
      }

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
