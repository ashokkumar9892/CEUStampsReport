// Netlify runs this for GET /api/report. The static page (copied into dist/ by
// scripts/build-netlify.js) calls it, and it calls the CEU Stamps API with the
// admin key, which lives only in Netlify's environment variables.

import { createApiSource } from '../../server/api.js';
import { loadConfig } from '../../server/config.js';
import { answerReport, basicAuthOk, SECURITY_HEADERS, UNAUTHORISED_HEADERS } from '../../server/endpoint.js';

// Netlify stops a synchronous function after 10 seconds; give up on the API before that.
const API_TIMEOUT_MS = 9_000;

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
  const problems = [...settings.problems];
  // A Netlify site is on the public internet: without a password this would hand
  // every student's name, licence, email, phone and address to anyone.
  if (!settings.auth) problems.push('REPORT_AUTH_USER and REPORT_AUTH_PASSWORD are not set.');
  if (problems.length) {
    return reply(500, {
      error: `The report site is not configured. In Netlify → Site configuration → Environment variables: ${problems.join(' ')} Then redeploy.`,
    });
  }

  if (!basicAuthOk(request.headers.get('authorization'), settings.auth)) {
    return reply(401, 'Sign in to view the report.', UNAUTHORISED_HEADERS);
  }
  if (request.method !== 'GET') return reply(405, 'Method not allowed.', { Allow: 'GET' });

  const source = createApiSource({ ...settings.api, timeoutMs: API_TIMEOUT_MS });
  const { status, body } = await answerReport(new URL(request.url).searchParams, source);
  return reply(status, body);
}

export const config = { path: '/api/report' };
