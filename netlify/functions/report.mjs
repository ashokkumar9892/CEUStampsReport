// Netlify runs this for GET /api/report. The static page (copied into dist/ by
// scripts/build-netlify.js) calls it, and it calls the CEU Stamps API with the
// admin key, which lives only in Netlify's environment variables.

import { createApiSource } from '../../server/api.js';
import { loadConfig, normaliseIp } from '../../server/config.js';
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

/**
 * The visitor's address, as Netlify recorded it from the connection.
 *
 * Only context.ip — never X-Forwarded-For or any other request header. A
 * visitor can send a header with whatever value they like, so trusting one
 * would let anyone claim to be an allowed address. With no context there is no
 * address, and the allow-list lets nobody in.
 */
function visitorIp(context) {
  return normaliseIp(context?.ip ?? '');
}

export default async function report(request, context) {
  const settings = loadConfig({ ...process.env, REPORT_SOURCE: 'api' });
  const problems = [...settings.problems];
  // A Netlify site is on the public internet: with no way to tell who is asking,
  // this would hand every student's name, licence, email, phone and address to anyone.
  if (!settings.allowedIps.length && !settings.auth) {
    problems.push(
      'Set REPORT_ALLOWED_IPS (the addresses allowed to open the report), or REPORT_AUTH_USER and REPORT_AUTH_PASSWORD.',
    );
  }
  if (problems.length) {
    return reply(500, {
      error: `The report site is not configured. In Netlify → Site configuration → Environment variables: ${problems.join(' ')} Then redeploy.`,
    });
  }

  const ip = visitorIp(context);
  const fromAllowedAddress = ip !== '' && settings.allowedIps.includes(ip);

  if (!fromAllowedAddress) {
    if (settings.auth) {
      // Listed addresses open straight in; everyone else can still sign in.
      if (!basicAuthOk(request.headers.get('authorization'), settings.auth)) {
        return reply(401, 'Sign in to view the report.', UNAUTHORISED_HEADERS);
      }
    } else {
      // Naming the address the site saw is what makes this fixable: when an
      // internet provider changes it, this is the value that belongs in the list.
      return reply(403, {
        error: `This report only opens from approved addresses, and ${ip || 'your address'} is not one of them. If this is your address, add it to REPORT_ALLOWED_IPS in Netlify and redeploy.`,
      });
    }
  }

  if (request.method !== 'GET') return reply(405, 'Method not allowed.', { Allow: 'GET' });

  const source = createApiSource({ ...settings.api, timeoutMs: API_TIMEOUT_MS });
  const { status, body } = await answerReport(new URL(request.url).searchParams, source);
  return reply(status, body);
}

export const config = { path: '/api/report' };
