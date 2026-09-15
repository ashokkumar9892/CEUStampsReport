# CEU Stamps usage report

A standalone, read-only rebuild of the CEU Stamps usage report. It answers who used
the site in a date range, which courses they took and how far they got, how to
reach them, and when and where they came from.

The full specification is [docs/report-requirements.md](docs/report-requirements.md);
code comments cite its section numbers (§5.2 and so on). The API it reads by default
is described in §9.

## Where the data comes from

| `REPORT_SOURCE` | Reads | Needs |
|---|---|---|
| `api` (default) | `GET https://ceustamps-api.azurewebsites.net/api/admin/report`, which applies the §5 rules itself | The API's admin key (`CEU_ADMIN_KEY`) |
| `sql` | `ceustampsdb` directly, with the two queries in §4 | A read-only SQL login and a firewall rule |

Both give the same page. `test/api.test.js` checks that they agree, using a response
produced by the API's own `report()` code.

## What it contains

| Path | Role |
|---|---|
| `server/api.js` | Calls the API server-side with `x-admin-key` and reshapes its answer |
| `server/db.js` | The two SQL queries (§4), parameterised, over an encrypted connection |
| `server/report.js` | SQL rows → people, courses, sittings, sign-ins and tiles (§5, §6.2) |
| `server/app.js` | Serves the page and `GET /api/report`; loopback / password guard (§7) |
| `server/config.js` | Settings from the environment; refuses unsafe ones |
| `shared/format.js` | IP, location, seat time, CSV and date-window rules — used by server and page |
| `shared/table.js` | Sorting and paging |
| `public/` | The page: filters, tiles, four sortable, paged tabs, CSV export |
| `sql/` | Scripts that create the read-only login, and the §8 cross-check |

Only one runtime dependency: [`mssql`](https://www.npmjs.com/package/mssql), for SQL
mode. The page has no build step and loads nothing from other sites.

## Setup

Needs Node.js 22.9 or newer.

```powershell
npm install
Copy-Item .env.example .env   # then fill it in, see below
npm start
```

Open <http://127.0.0.1:5180>. The report loads the last 30 days once when the page
opens. After that it only runs when you press **Run report** or a shortcut. The status
line says which source the data came from.

### API mode (default)

Set `REPORT_API_KEY` in `.env` to the `CEU_ADMIN_KEY` configured on the
`ceustamps-api` Web App.

- **The key never reaches the browser.** This server calls the API and passes the
  result on. Browsers can't call the API with the key directly anyway: its CORS rules
  don't allow `x-admin-key`.
- `REPORT_API_URL` must be `https://` (plain `http://` is accepted only for
  `localhost`), and redirects are never followed, so the key can't be sent anywhere
  else.
- **The endpoint is live** since 10 Sep 2026 (API commit `83061df`, with
  `CEU_ADMIN_KEY` set). If the API is ever rolled back to code without it, the page
  says the endpoint is missing; with a wrong key it says the key was refused.
- **Real students appear only once `ceustamps.com` sends visits.** Until that site
  is built with `VITE_API_BASE` (§9.1.1), the report shows only deployment-check rows.

### SQL mode

Set `REPORT_SOURCE=sql` and `REPORT_SQL_PASSWORD`. Then, once, as `tradealgoadmin`:

1. [`sql/01-master-create-login.sql`](sql/01-master-create-login.sql) against **master**, with a new strong password.
2. [`sql/02-ceustampsdb-grant-report-user.sql`](sql/02-ceustampsdb-grant-report-user.sql) against **ceustampsdb**.

This gives `ceustamps_report` `SELECT` only, and never on `sessions.token_hash` or
`courses.body`. The app refuses to start as `ceustamps_app` or the admin.

The SQL server lets in Azure services and `98.122.179.148`. From anywhere else, add
the machine's public IP:

```powershell
az sql server firewall-rule create -g TradeAlgoResource -s tradealgo-sql8892 `
  -n ReportApp --start-ip-address <app IP> --end-ip-address <app IP>
```

## Hosting on Netlify

[netlify.toml](netlify.toml) sets this up. It publishes only the page (`dist/`,
built from `public/` and `shared/` by `npm run build:netlify`) and runs
`/api/report` as the function [netlify/functions/report.mjs](netlify/functions/report.mjs).
On Netlify the report always reads through the API; SQL mode isn't available,
because Netlify's addresses aren't in the SQL firewall.

In **Site configuration → Environment variables**, set:

| Variable | Value |
|---|---|
| `REPORT_API_KEY` | The `ceustamps-api` Web App's `CEU_ADMIN_KEY` — required |
| `REPORT_AUTH_USER`, `REPORT_AUTH_PASSWORD` | Optional — set both to make every visitor sign in |

Then redeploy. The function refuses to return any data until the key is set.

**The report is open to every address, with no sign-in** (the owner's decision,
15 Sep 2026). Anyone with the link sees every student's name, licence, email,
phone and IP address. The admin key itself stays in the function and never
reaches a browser. To lock the report again, set the sign-in pair and redeploy.
`REPORT_ALLOWED_IPS` is no longer read; it can be deleted from Netlify.

The easiest way to set the key is [scripts/copy-report-site-settings.ps1](scripts/copy-report-site-settings.ps1),
run in your own PowerShell window after `az login`. It puts the admin key on the
clipboard, keeps it out of clipboard history, and after you redeploy checks that
the site answers.

## Who can open it

- **On Netlify**, see above: anyone, unless a sign-in pair is set.
- **Run locally (`npm start`) it listens on `127.0.0.1` only.** Other machines can't
  connect. Requests that arrived through a proxy (`X-Forwarded-For`, `Forwarded`, …)
  or with a foreign `Host` header (DNS rebinding) are refused.
- **To host it elsewhere**, set `REPORT_HOST=0.0.0.0` (or the platform's address). The app will
  then refuse to start unless `REPORT_AUTH_USER` and `REPORT_AUTH_PASSWORD` are set,
  and browsers will ask for them. Serve it only over HTTPS, and where the host
  allows it, also restrict which addresses can reach it (for example, App Service
  access restrictions). On Azure App Service, `PORT` is picked up automatically.
  Put the secrets in the app settings, not in files.

The page shows name, licence, email, phone, IP address and location for every
student, so treat both the page and its CSV exports as personal data.

## Checking the numbers

[`sql/check-counts.sql`](sql/check-counts.sql) computes People / Sittings / Sign-ins
straight from the database. The status line under the filters prints the exact UTC
window the page used, so paste that into `@from` / `@to` and compare with the tiles.

## Tests

```powershell
npm test
```

Covers the aggregation rules, the API adapter and its error messages,
API ↔ database parity, IP / location / CSV rules, the local-time date window,
sorting and paging, and the HTTP guards. Nothing touches the network or the
database.

## Notes on the data

- Rows written before 9 Sep 2026 store IPs with a source port (`1.2.3.4:61347`), and
  the API returns addresses raw. The port is stripped for display and grouping. The
  Sittings / Sign-ins CSVs keep the stored value.
- In API mode, the Locations tile says so when the API has address lookup switched
  off (`CEU_GEOIP_URL` unset). The Sittings tile can't say how many demo sittings
  were hidden, because the API doesn't report that.
- Sessions older than migration 003 have no location and never will.
- The existing deployment-check sessions (`Deploy Check`, `Gate Test`, …) are not
  filtered out; they count like any other sitting, as in the original report.
