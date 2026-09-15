// Settings come from the environment (or .env, loaded by `npm start`).

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
// §2.1 — the live API's login can rewrite compliance records; the admin can do anything.
const FORBIDDEN_LOGINS = new Set(['ceustamps_app', 'tradealgoadmin']);
const SOURCES = ['api', 'sql'];

export function loadConfig(env = process.env) {
  const problems = [];
  const host = env.REPORT_HOST || '127.0.0.1';
  const port = Number(env.REPORT_PORT || env.PORT || 5180);
  const local = LOOPBACK_HOSTS.has(host);
  const source = (env.REPORT_SOURCE || 'api').toLowerCase();

  // Where the data comes from: the live API's report endpoint (default), or the
  // database directly with the read-only login.
  const api = {
    url: env.REPORT_API_URL || 'https://ceustamps-api.azurewebsites.net',
    key: env.REPORT_API_KEY || '',
  };
  const sql = {
    server: env.REPORT_SQL_SERVER || 'tradealgo-sql8892.database.windows.net',
    port: Number(env.REPORT_SQL_PORT || 1433),
    database: env.REPORT_SQL_DATABASE || 'ceustampsdb',
    user: env.REPORT_SQL_USER || 'ceustamps_report',
    password: env.REPORT_SQL_PASSWORD || '',
  };

  const auth =
    env.REPORT_AUTH_USER && env.REPORT_AUTH_PASSWORD
      ? { user: env.REPORT_AUTH_USER, password: env.REPORT_AUTH_PASSWORD }
      : null;

  if (!SOURCES.includes(source)) problems.push(`REPORT_SOURCE must be "api" or "sql", not "${source}".`);

  if (source === 'api') {
    if (!api.key) problems.push("REPORT_API_KEY is not set — use the API's CEU_ADMIN_KEY.");
    let parsed = null;
    try {
      parsed = new URL(api.url);
    } catch {
      problems.push(`REPORT_API_URL ${api.url} is not a URL.`);
    }
    // The key opens every student's details; never send it in clear text.
    if (parsed && parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''))) {
      problems.push('REPORT_API_URL must use https:// so the admin key is not sent in clear text.');
    }
  }

  if (source === 'sql') {
    if (!sql.password) problems.push('REPORT_SQL_PASSWORD is not set (put it in .env).');
    if (FORBIDDEN_LOGINS.has(sql.user.toLowerCase())) {
      problems.push(`REPORT_SQL_USER is ${sql.user}; use the read-only report login instead (sql/02-ceustampsdb-grant-report-user.sql).`);
    }
  }

  if (!local && !auth) {
    problems.push(`REPORT_HOST is ${host}, which other machines can reach; set REPORT_AUTH_USER and REPORT_AUTH_PASSWORD.`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`REPORT_PORT ${port} is not a valid port.`);

  return { host, port, local, source, api, sql, auth, problems };
}
