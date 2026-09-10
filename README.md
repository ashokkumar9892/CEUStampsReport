# CEU Stamps usage report

A standalone, read-only rebuild of the CEU Stamps usage report. It answers who used
the site in a date range, which courses they took and how far they got, how to
reach them, and when and where they came from.

The full specification is [docs/report-requirements.md](docs/report-requirements.md);
code comments cite its section numbers (§5.2 and so on).

## What it contains

| Path | Role |
|---|---|
| `server/db.js` | The two queries (§4), parameterised, over an encrypted connection |
| `server/report.js` | Rows → people, courses, sittings, sign-ins and tiles (§5, §6.2) |
| `server/app.js` | Serves the page and `GET /api/report`; loopback / password guard (§7) |
| `server/config.js` | Settings from the environment; refuses unsafe ones |
| `shared/format.js` | IP, location, seat time, CSV and date-window rules — used by server and page |
| `shared/table.js` | Sorting and paging |
| `public/` | The page: filters, tiles, four sortable, paged tabs, CSV export |
| `sql/` | Scripts that create the read-only login, and the §8 cross-check |

Only one runtime dependency: [`mssql`](https://www.npmjs.com/package/mssql). The page
has no build step and loads nothing from other sites.

## Setup

Needs Node.js 22.9 or newer.

### 1. Create the read-only login (once)

Sign in as `tradealgoadmin` (Azure Data Studio, SSMS, or the portal query editor) and run:

1. [`sql/01-master-create-login.sql`](sql/01-master-create-login.sql) against **master**, with a new strong password.
2. [`sql/02-ceustampsdb-grant-report-user.sql`](sql/02-ceustampsdb-grant-report-user.sql) against **ceustampsdb**.

This gives `ceustamps_report` `SELECT` only, and never on `sessions.token_hash` or
`courses.body`. Do not use `ceustamps_app` for this: it can write and change the
schema. The app refuses to start if you configure it or the admin login.

### 2. Firewall

The SQL server lets in Azure services and `98.122.179.148`. From anywhere else, add
the machine's public IP:

```powershell
az sql server firewall-rule create -g TradeAlgoResource -s tradealgo-sql8892 `
  -n ReportApp --start-ip-address <app IP> --end-ip-address <app IP>
```

If you skip this, the page shows the server's "not allowed to access the server"
error, which includes the IP address it saw.

### 3. Configure and run

```powershell
npm install
Copy-Item .env.example .env   # then set REPORT_SQL_PASSWORD
npm start
```

Open <http://127.0.0.1:5180>. The report loads the last 30 days once when the page
opens. After that it only runs when you press **Run report** or a shortcut.

## Who can open it

- **By default it listens on `127.0.0.1` only.** Other machines can't connect. Requests
  that arrived through a proxy (`X-Forwarded-For`, `Forwarded`, …) or with a
  foreign `Host` header (DNS rebinding) are refused.
- **To host it**, set `REPORT_HOST=0.0.0.0` (or the platform's address). The app will
  then refuse to start unless `REPORT_AUTH_USER` and `REPORT_AUTH_PASSWORD` are set,
  and browsers will ask for them. Serve it only over HTTPS, and where the host
  allows it, also restrict which addresses can reach it (for example, App Service
  access restrictions). On Azure App Service, `PORT` is picked up automatically.
  Put the secrets in the app settings, not in files.

The page shows name, licence, email, phone, IP address and location for every
student, so treat both the page and its CSV exports as personal data.

## Checking the numbers

[`sql/check-counts.sql`](sql/check-counts.sql) computes People / Sittings / Sign-ins
directly. The status line under the filters prints the exact UTC window the page
used, so paste that into `@from` / `@to` and compare with the tiles.

## Tests

```powershell
npm test
```

Covers the aggregation rules, IP / location / CSV rules, the local-time date
window, sorting and paging, and the HTTP guards. The tests use fixture rows and
never touch the database.

## Notes on the data

- Rows written before 9 Sep 2026 store IPs with a source port (`1.2.3.4:61347`).
  The port is stripped for display and grouping. The Sittings / Sign-ins CSVs keep
  the stored value.
- Sessions older than migration 003 have no location and never will.
- The existing deployment-check sessions (`Deploy Check`, `Gate Test`, …) are not
  filtered out; they count like any other sitting, as in the original report.
