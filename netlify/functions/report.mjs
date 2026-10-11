// Netlify runs this for GET /api/report. The static page (copied into dist/ by
// scripts/build-netlify.js) calls it, and it calls the CEU Stamps API with the
// admin key, which lives only in Netlify's environment variables.
//
// Open to every address. The owner chose this on 15 Sep 2026, knowing the
// report shows every student's name, licence, email, phone and IP address to
// whoever has the link. What stays protected is the admin key: it never leaves
// this function, so nobody can query the API directly.
//
// To lock the report again without a code change, set REPORT_AUTH_USER and
// REPORT_AUTH_PASSWORD in Netlify and redeploy: every visitor is then asked to
// sign in.

import { createApiSource } from '../../server/api.js';
import { loadConfig } from '../../server/config.js';
import { answerReport, basicAuthOk, SECURITY_HEADERS, UNAUTHORISED_HEADERS } from '../../server/endpoint.js';
import { createLocator, withLocations } from '../../server/geo.js';
import { createRads10Source, fillVisitLocations } from '../../server/rads10.js';

// Netlify stops a synchronous function after 10 seconds. The API gets most of it;
// city/state lookups use what is left, and whatever is unfinished by 8.5s stays unresolved.
const API_TIMEOUT_MS = 6_500;
const REPORT_BUDGET_MS = 8_500;

// Module scope, so answers are remembered for as long as Netlify keeps this
// function warm and a re-run does not ask the lookup service again.
const locate = createLocator();

function reply(status, body, headers = {}) {
  const text = typeof body === 'string';
  return new Response(text ? body : JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export default async function report(request) {
  const settings = loadConfig({ ...process.env, REPORT_SOURCE: 'api' });
  if (settings.problems.length) {
    return reply(500, {
      error: `The report site is not configured. In Netlify → Site configuration → Environment variables: ${settings.problems.join(' ')} Then redeploy.`,
    });
  }

  if (settings.auth && !basicAuthOk(request.headers.get('authorization'), settings.auth)) {
    return reply(401, 'Sign in to view the report.', UNAUTHORISED_HEADERS);
  }

  if (request.method !== 'GET') return reply(405, 'Method not allowed.', { Allow: 'GET' });

  // One source per tab of the page (?site=); both read the same API with the same key.
  const ceu = createApiSource({ ...settings.api, timeoutMs: API_TIMEOUT_MS });
  const rads10 = createRads10Source({ ...settings.api, timeoutMs: API_TIMEOUT_MS });
  const sources = settings.geoip
    ? {
        ceu: withLocations(ceu, locate, { budgetMs: REPORT_BUDGET_MS }),
        rads10: withLocations(rads10, locate, { budgetMs: REPORT_BUDGET_MS, fill: fillVisitLocations }),
      }
    : { ceu, rads10 };
  const { status, body } = await answerReport(new URL(request.url).searchParams, sources);
  return reply(status, body);
}

export const config = { path: '/api/report' };
