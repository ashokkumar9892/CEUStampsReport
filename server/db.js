// Read-only access to ceustampsdb (§2, §4). Columns are listed explicitly: the
// report login's column grants refuse SELECT *, and sessions.token_hash and
// courses.body must never be read.

import sql from 'mssql';
import { buildReport } from './report.js';

const SITTINGS_SQL = `
SELECT
  s.id AS session_id, s.first_name, s.last_name, s.license_number, s.email, s.phone,
  s.state_code, s.course_id, s.voucher_code, s.started_at, s.completed_at,
  s.credited_seconds, s.module_index, s.is_demo,
  s.created_ip, s.created_city, s.created_region, s.created_country, s.user_agent,
  c.title AS course_title, c.program_id, c.program_title, c.section_number, c.section_count,
  sc.passed, sc.score_percent, sc.seat_seconds,
  cert.number AS certificate_number
FROM dbo.sessions AS s
LEFT JOIN dbo.courses             AS c    ON c.id = s.course_id
LEFT JOIN dbo.section_completions AS sc   ON sc.session_id = s.id
LEFT JOIN dbo.certificates        AS cert ON cert.session_id = s.id
WHERE s.started_at >= @from AND s.started_at < @to
ORDER BY s.started_at ASC;`;

// active_seconds and last_active_at come from CEU-Website migration 005.
const SIGN_INS_SQL = `
SELECT id, at, license_number, state_code, first_name, last_name, email, phone,
       created_ip, created_city, created_region, created_country, user_agent,
       active_seconds, last_active_at
FROM dbo.sign_ins
WHERE at >= @from AND at < @to
ORDER BY at ASC;`;

export function createSqlStore({ server, port, database, user, password }) {
  let connecting = null;

  function pool() {
    if (!connecting) {
      const p = new sql.ConnectionPool({
        server,
        port,
        database,
        user,
        password,
        options: { encrypt: true, trustServerCertificate: false, useUTC: true },
        pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
        connectionTimeout: 30_000,
        requestTimeout: 60_000,
      });
      // Forget a failed attempt so the next request retries instead of reusing the error.
      connecting = p.connect().catch((err) => {
        connecting = null;
        throw err;
      });
    }
    return connecting;
  }

  async function query(text, from, to) {
    const p = await pool();
    const result = await p
      .request()
      .input('from', sql.DateTime2(3), from)
      .input('to', sql.DateTime2(3), to)
      .query(text);
    return result.recordset;
  }

  return {
    reportSessions: (from, to) => query(SITTINGS_SQL, from, to),
    reportSignIns: (from, to) => query(SIGN_INS_SQL, from, to),
    async close() {
      if (connecting) await (await connecting).close();
    },
  };
}

export function describeDbError(err) {
  const message = String(err?.message ?? err);
  if (/not allowed to access the server/i.test(message)) {
    return `${message} Add this machine's public IP to the SQL server firewall (README, "Firewall").`;
  }
  if (/permission was denied/i.test(message)) {
    return `${message} The report login is missing a grant — run sql/02-ceustampsdb-grant-report-user.sql.`;
  }
  if (err?.code === 'ELOGIN') return `${message} Check REPORT_SQL_USER and REPORT_SQL_PASSWORD.`;
  return message;
}

/** A report source over anything with the two query methods. */
export function sourceFromStore(store) {
  return {
    async report({ from, to, includeDemo = false }) {
      let rows;
      try {
        rows = await Promise.all([store.reportSessions(from, to), store.reportSignIns(from, to)]);
      } catch (err) {
        throw new Error(`Could not read the database. ${describeDbError(err)}`, { cause: err });
      }
      return buildReport(rows[0], rows[1], { from, to, includeDemo });
    },
    close: async () => store.close?.(),
  };
}

export const createSqlSource = (config) => sourceFromStore(createSqlStore(config));
