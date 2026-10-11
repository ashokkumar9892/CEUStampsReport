// GET /api/report, shared by the Node server (server/app.js) and the Netlify
// function (netlify/functions/report.mjs).

import { createHash, timingSafeEqual } from 'node:crypto';

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

export const UNAUTHORISED_HEADERS = { 'WWW-Authenticate': 'Basic realm="CEU Stamps report", charset="UTF-8"' };

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

/** Checks an Authorization header against { user, password } in constant time. */
export function basicAuthOk(header, { user, password }) {
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  return Boolean(m) && timingSafeEqual(digest(Buffer.from(m[1], 'base64').toString('utf8')), digest(`${user}:${password}`));
}

function parseInstant(value) {
  if (!value || !INSTANT.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The products this report covers; `?site=` picks one, and CEU Stamps is the default. */
export const SITES = ['ceu', 'rads10'];

/**
 * @param params  the request's URLSearchParams: from, to (UTC instants), includeDemo=1, site
 * @param source  anything with report({ from, to, includeDemo }), or one of those per site: { ceu, rads10 }
 * @returns { status, body } — body is JSON-serialisable
 */
export async function answerReport(params, sources, log = console) {
  const site = params.get('site') || 'ceu';
  if (!SITES.includes(site)) return { status: 400, body: { error: `There is no report for "${site}".` } };
  const source = typeof sources.report === 'function' ? (site === 'ceu' ? sources : null) : sources[site];
  if (!source) return { status: 404, body: { error: `The ${site} report is not available from this server.` } };

  const from = parseInstant(params.get('from'));
  const to = parseInstant(params.get('to'));
  if (!from || !to) {
    return { status: 400, body: { error: 'from and to must be UTC timestamps, e.g. 2026-09-01T07:00:00.000Z.' } };
  }
  if (to <= from) return { status: 400, body: { error: 'The end of the range must be after its start.' } };

  try {
    return { status: 200, body: await source.report({ from, to, includeDemo: params.get('includeDemo') === '1' }) };
  } catch (err) {
    log.error('Report failed:', err);
    return { status: 502, body: { error: err.message || 'The report could not be loaded.' } };
  }
}
