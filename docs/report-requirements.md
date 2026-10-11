# Usage Report — Requirements for a Standalone Report Application

This document specifies everything needed to rebuild the CEU Stamps usage report
(`#/report` in this repository) as a separate application: where the data lives,
how to connect, which tables and columns it reads, the exact queries, the rules
that turn rows into the report, and what the page shows.

Every rule here is taken from the working implementation:

| Concern | Source in this repo |
|---|---|
| SQL queries | `server/src/stores/sql.js` — `reportSessions`, `reportSignIns` |
| Aggregation rules | `server/src/service.js` — `report()` |
| Page, tabs, columns, sorting, paging, CSV | `src/components/ReportScreen.jsx` |
| Schema | `server/sql/001_schema.sql` … `004_sign_ins.sql` |

---

## 1. What the report answers

1. **How many unique people** used the site in a date range — whether they only
   signed in, enrolled in a course, or both.
2. **Which course** each person is taking, and how far they got.
3. **Who they are** — name, licence number, email, phone.
4. **When and from where** — time of each visit or sitting, IP address, and the
   city / state / country that address resolved to.

---

## 2. Connection

| Setting | Value |
|---|---|
| Engine | Azure SQL Database |
| Server | `tradealgo-sql8892.database.windows.net` |
| Port | `1433` |
| Database | `ceustampsdb` |
| Encryption | **Required** — `Encrypt=True`, `TrustServerCertificate=False` |
| Azure resource group | `TradeAlgoResource` |
| SQL admin login | `tradealgoadmin` (for creating the report login only — never for the app) |

The server is shared: it also hosts `tradealgodb`. `ceustampsdb` is deliberately a
separate database so its point-in-time restore can never be affected by the other.

### 2.1 Login — use a new read-only one

The existing login **`ceustamps_app`** belongs to the live API and holds
`db_datareader`, `db_datawriter` **and** `db_ddladmin`. It can rewrite compliance
records and alter the schema. **Do not use it for reporting.**

Create a dedicated read-only login instead. Run as `tradealgoadmin`:

```sql
-- 1) In the master database
CREATE LOGIN [ceustamps_report] WITH PASSWORD = '<choose a new strong password>';
```

```sql
-- 2) In ceustampsdb
CREATE USER [ceustamps_report] FOR LOGIN [ceustamps_report];

-- Whole tables that carry nothing sensitive beyond what the report shows.
GRANT SELECT ON OBJECT::dbo.sign_ins            TO [ceustamps_report];
GRANT SELECT ON OBJECT::dbo.section_completions TO [ceustamps_report];
GRANT SELECT ON OBJECT::dbo.certificates        TO [ceustamps_report];

-- courses: every column EXCEPT body. body holds the full question pool,
-- including the correct answers.
GRANT SELECT ON OBJECT::dbo.courses
  (id, state_code, title, published_at, program_id, program_title, section_number, section_count)
  TO [ceustamps_report];

-- sessions: every column EXCEPT token_hash. token_hash identifies live
-- student sessions and has no place in a report.
GRANT SELECT ON OBJECT::dbo.sessions
  (id, voucher_code, course_id, state_code, first_name, last_name, license_number,
   email, phone, started_at, completed_at, module_index, credited_seconds,
   first_try_perfect, is_demo, created_ip, user_agent,
   created_city, created_region, created_country)
  TO [ceustamps_report];
```

With column-level grants, `SELECT * FROM dbo.sessions` or `SELECT * FROM dbo.courses`
will be **refused**. That is intended — list columns explicitly, as the queries in
§4 do.

### 2.2 Passwords

- **The new `ceustamps_report` password** is whatever you set above. Store it in
  the report application's secret store (e.g. its hosting provider's app settings
  or a key vault), never in source control.
- **The existing `ceustamps_app` password is not written in this document**, on
  purpose. It lives only in the `ceustamps-api` Web App's settings. If you
  genuinely need it, retrieve it on a machine signed in with `az login`:

  ```powershell
  . ./deploy/get-ceustamps-env.ps1 -Show
  ```

### 2.3 Firewall

The server currently allows:

| Rule | Range | Meaning |
|---|---|---|
| `AllowAzureServices` | `0.0.0.0` | Any Azure-hosted service — note this covers *every* Azure tenant, not only yours |
| `LocalPC` | `98.122.179.148` | Your office / home address |

A report application hosted **outside Azure and away from that address will be
refused** until you add its public IP:

```powershell
az sql server firewall-rule create -g TradeAlgoResource -s tradealgo-sql8892 `
  -n ReportApp --start-ip-address <app IP> --end-ip-address <app IP>
```

### 2.4 Connection string examples

ADO.NET / .NET:

```
Server=tcp:tradealgo-sql8892.database.windows.net,1433;Database=ceustampsdb;User ID=ceustamps_report;Password=<secret>;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;
```

Node (`mssql` package):

```js
{
  server: 'tradealgo-sql8892.database.windows.net',
  port: 1433,
  database: 'ceustampsdb',
  user: 'ceustamps_report',
  password: process.env.REPORT_SQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
}
```

---

## 3. Tables

The report reads **five tables**. It does **not** read `vouchers`, `attempts`,
`steps`, `step_rejections`, `audit_log` or `schema_version`.

All timestamps are **`DATETIME2(3)` in UTC**, written by the server clock.

### 3.1 `dbo.sessions` — one enrollment ("sitting")

The compliance record. A row is created when a student redeems a voucher.

| Column | Type | Used for |
|---|---|---|
| `id` | `UNIQUEIDENTIFIER` PK | Joins; row identity |
| `first_name`, `last_name` | `NVARCHAR(120)` | Student name |
| `license_number` | `NVARCHAR(60)` | **Person identity** (see §5.2) |
| `email` | `NVARCHAR(240)` NULL | Contact |
| `phone` | `NVARCHAR(60)` NULL | Contact |
| `state_code` | `NCHAR(2)` | State (trim it — fixed width) |
| `course_id` | `NVARCHAR(64)` | Join to `courses.id` |
| `voucher_code` | `NVARCHAR(32)` | Available; not displayed |
| `started_at` | `DATETIME2(3)` | **Date filter**; "Started"; first/last seen |
| `completed_at` | `DATETIME2(3)` NULL | NULL = still in progress |
| `credited_seconds` | `INT` | Seat time when no completion row exists |
| `module_index` | `INT` | Available; not displayed |
| `is_demo` | `BIT` | **Excluded by default** (§5.3) |
| `created_ip` | `NVARCHAR(64)` NULL | IP address at enrollment |
| `created_city`, `created_region` | `NVARCHAR(120)` NULL | Location (from migration 003) |
| `created_country` | `NVARCHAR(80)` NULL | Location |
| `user_agent` | `NVARCHAR(400)` NULL | "Device" in CSV |
| ~~`token_hash`~~ | `CHAR(64)` | **Never select** |

### 3.2 `dbo.sign_ins` — someone identified themselves on the site

One row per visit by an identified person (migration 004). Recorded when a
student signs in on a catalogue page, **and again on each later browser session**
while they stay signed in — so rows are effectively *visits*.

> **Self-declared and unverified.** Nobody checks that the licence number is real
> or belongs to the person who typed it. Never present a sign-in as evidence that
> a student sat a course — that is what `sessions` is for.

| Column | Type | Used for |
|---|---|---|
| `id` | `UNIQUEIDENTIFIER` PK | Row identity |
| `at` | `DATETIME2(3)` | **Date filter**; "When"; first/last seen |
| `license_number` | `NVARCHAR(60)` | Person identity |
| `state_code` | `NCHAR(2)` NULL | State |
| `first_name`, `last_name` | `NVARCHAR(120)` NULL | Name (split from a single "Name" box) |
| `email` | `NVARCHAR(240)` NULL | Contact |
| `phone` | `NVARCHAR(60)` NULL | Contact |
| `created_ip` | `NVARCHAR(64)` NULL | IP address |
| `created_city`, `created_region`, `created_country` | `NVARCHAR` NULL | Location |
| `user_agent` | `NVARCHAR(400)` NULL | "Device" in CSV |

### 3.3 `dbo.courses` — the course a sitting was for

| Column | Type | Used for |
|---|---|---|
| `id` | `NVARCHAR(64)` PK | Join from `sessions.course_id` |
| `title` | `NVARCHAR(300)` | Course / section name |
| `program_id` | `NVARCHAR(64)` NULL | Set when the row is one section of a programme |
| `program_title` | `NVARCHAR(300)` NULL | Programme name |
| `section_number` | `INT` NULL | Section position |
| `section_count` | `INT` NULL | Sections in the programme |
| ~~`body`~~ | `NVARCHAR(MAX)` JSON | **Never select** — contains the answer key |

### 3.4 `dbo.section_completions` — how a programme section ended

Written **only for courses that are sections of a programme** (`program_id` set),
once the section is finished — passed or failed. Single-sitting courses have no row.

| Column | Type | Used for |
|---|---|---|
| `session_id` | `UNIQUEIDENTIFIER` | Join to `sessions.id` (one row per session) |
| `passed` | `BIT` | Pass / fail |
| `score_percent` | `INT` | Score |
| `seat_seconds` | `INT` | Credited seat time (preferred over `sessions.credited_seconds`) |

### 3.5 `dbo.certificates`

| Column | Type | Used for |
|---|---|---|
| `session_id` | `UNIQUEIDENTIFIER` | Join to `sessions.id` |
| `number` | `NVARCHAR(40)` | Certificate number |

---

## 4. Queries

Both take a **half-open UTC window**: `@from` inclusive, `@to` exclusive, both
`DATETIME2(3)`. See §5.1 for how to build it — getting this wrong hides the most
recent activity.

### 4.1 Sittings

```sql
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
ORDER BY s.started_at ASC;
```

All three joins **must be LEFT joins**: a student still part-way through has no
completion row and no certificate, and an inner join would silently drop them.

### 4.2 Sign-ins

```sql
SELECT id, at, license_number, state_code, first_name, last_name, email, phone,
       created_ip, created_city, created_region, created_country, user_agent
FROM dbo.sign_ins
WHERE at >= @from AND at < @to
ORDER BY at ASC;
```

Use parameters for `@from` / `@to` — never concatenate values into the SQL.

---

## 5. Rules

### 5.1 Date range — build it on the operator's clock

The user picks **From** and **To** as calendar days in their own timezone. Stored
times are UTC. Convert before querying:

- `@from` = **local midnight** at the start of the From day, converted to UTC.
- `@to` = **local midnight at the start of the day _after_ the To day**, converted to UTC.

Example, operator in US Pacific (UTC−7), range 1–9 Sep 2026:
`@from = 2026-09-01T07:00:00Z`, `@to = 2026-09-10T07:00:00Z`.

**Do not** send bare dates and build the window in UTC. West of Greenwich the
server is already on tomorrow's date by early evening, so anything that just
happened falls outside a range ending "today" and the report looks empty. This was
a real bug in the first version.

Reject a range whose end is not after its start.

### 5.2 A person is their licence number

`person key = UPPER(TRIM(license_number))`, across **both** `sessions` and `sign_ins`.

Not the session (a four-hour programme is eight sittings, so one student would
count as eight) and not the IP address (someone moving between home and a job site
would count as two).

When combining a person's rows:

| Field | Rule |
|---|---|
| Name | From their **sittings** if any (checked details win); otherwise from a sign-in. Format `first_name + ' ' + last_name`, trimmed. A sign-in with no name reads `(no name given)`. |
| Email, phone | The most recent sitting's value; otherwise the first sign-in that has one. |
| State | From a sitting if any; otherwise a sign-in. Trim the `NCHAR(2)`. |
| First seen / Last seen | Earliest / latest of `sign_ins.at` and `sessions.started_at`. |
| Courses taken | Distinct course labels (§5.4) from their sittings, sorted. |
| IP addresses, locations | Distinct values across all their rows. |

### 5.3 Demo sittings

`sessions.is_demo = 1` rows are **excluded by default**. Provide an
"Include demo sittings" toggle. Sign-ins have no demo flag and are always included.

### 5.4 Course label

- If `program_title` **and** `section_number` are set: `"{program_title} — Section {section_number}"`
- Otherwise `courses.title`
- Otherwise the raw `course_id`

### 5.5 Result, score and seat time (per sitting)

| Situation | Show |
|---|---|
| `completed_at` IS NULL | **in progress** |
| Completed, no `section_completions` row (single-sitting course) | **finished** |
| Completed with a row | **`{score_percent}% pass`** or **`fail`** from `passed` |

- **Seat minutes** = `ROUND(COALESCE(sc.seat_seconds, s.credited_seconds, 0) / 60.0)`
- **Average score** = rounded mean of the non-null `score_percent` values; blank if none.

### 5.6 Location

`location = city, region, country` joined with `", "`, skipping NULLs; blank if all
three are NULL. Example: `Concord, North Carolina, United States`.

Three different "no location" cases — keep them apart:

| Case | Show in Location |
|---|---|
| No IP recorded | `—` |
| Private / loopback IP (never sent to a lookup service) | `no public address` |
| Public IP that the lookup could not place | `not resolved` |

### 5.7 IP address display

| Stored value | Show |
|---|---|
| `::1`, `::ffff:127.0.0.1`, `127.*` | `this machine` (loopback — browsing on the same machine as the API) |
| `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*`, `fc00::/7` | `local network` |
| Anything else | The address exactly as stored |

The CSV always exports the **raw** stored value.

### 5.8 Known quirks in existing data

- **Addresses with a port.** Rows written before 9 Sep 2026 store the address with
  its source port, e.g. `98.122.179.148:61347`. Strip a trailing `:port` from an
  IPv4 address (and the port from a bracketed IPv6 `[…]:port`) before showing or
  grouping. Never strip from a plain IPv6 address — its last group looks like a port.
- **No location on older rows.** Sessions created before migration 003 have
  NULL city / region / country. They will never have one.
- **Test rows.** The seven current sessions (`Deploy Check`, `Gate Test`,
  `Section Check`, `Enc Check` ×2, `Std Check`, `Fin Check`) are deployment checks,
  not students.

---

## 6. The report page

### 6.1 Filters

- **From** and **To** date pickers — default: 30 days ago → today.
- Shortcuts: **Last 7 days**, **Last 30 days**, **Last 90 days**.
- **Include demo sittings** checkbox — default off.
- **Run report** button. Load once on open; afterwards only on request, so a
  half-typed date never fires a query.

### 6.2 Summary tiles

| Tile | Definition |
|---|---|
| **People** | Distinct person keys across sittings and sign-ins in range. Sub-text: how many **signed in only** (no sittings). |
| **Sign-ins** | Count of `sign_ins` rows in range |
| **Sittings** | Count of `sessions` rows in range (after the demo rule) |
| **Finished** | Sittings with `completed_at` set. Sub-text: count with a certificate. |
| **Seat time** | Sum of seat minutes, shown as `Xh Ym` |
| **Locations** | Sittings with a location **plus** sign-ins with a location |

### 6.3 Tabs

Four tabs, each showing its row count in the label. **Every column is sortable**.

#### Students — one row per person · default sort **Last seen, newest first**

| Column | Source |
|---|---|
| Student | Name (§5.2) |
| Licence | Person key |
| Email | §5.2 |
| Phone | §5.2 |
| Courses taken | First course + "+N more"; `signed in, never enrolled` when none |
| Sign-ins | Count of their sign-in rows |
| Sittings | Count of their sittings |
| Finished | Count of their completed sittings |
| Seat time | Sum of seat minutes |
| Last seen | §5.2 |
| IP address | First address + "+N" (§5.7) |
| Location | First location + "+N" (§5.6) |

#### Courses — one row per course · default sort **Sittings, most first**

| Column | Source |
|---|---|
| Course | Course label (§5.4) |
| State | Sitting state |
| Students | Distinct person keys who sat it |
| Sittings | Count |
| Finished | Completed count, with "N passed" |
| Average score | §5.5 |
| IP address | Distinct addresses it was sat from — a course has many students, so this is a set, not one person's |
| Location | Distinct locations, deduplicated (eight sittings from one office = one place) |

#### Sittings — one row per enrollment · default sort **Started, newest first**

Started · Student · Licence · Email · Phone · Course · Result (§5.5) · Seat time ·
IP address · Location

#### Sign-ins — one row per visit · default sort **When, newest first**

When · Name · Licence · Email · Phone · IP address · Location

Show a footnote on the page: *"A sign-in is self-declared and unverified — the
record a board relies on is the sittings, which start from a redeemed voucher."*

### 6.4 Sorting

- Clicking a header sorts by it; clicking again reverses.
- Dates and counts open **largest / newest first**; text opens **A → Z**.
- Empty values sort **last in both directions**.
- Mark only the active column (arrow + `aria-sort`).
- Switching tabs resets to that tab's default sort.
- **Sort before paging**, so a page is a slice of the sorted list.

### 6.5 Paging

- **10 rows per page** by default; choices 10 / 25 / 50 / 100.
- Controls: First · Previous · *Page N of M* · Next · Last.
- Always show *"Showing X–Y of Z"*.
- Hide the page buttons when everything fits on one page.
- Reset to page 1 when the tab, sort, page size or data changes.

### 6.6 CSV export

- Exports **the tab on screen**, **every row in the range** — not just the current page.
- Uses raw stored values (full IP addresses, ISO timestamps).
- Includes fields the grid has no room for:

| Tab | CSV columns |
|---|---|
| Students | Name, Licence, Email, Phone, State, Courses taken, Sign-ins, Sittings, Finished, Seat minutes, Average score, First seen, Last seen, Addresses, Locations |
| Courses | Course, State, Students, Sittings, Finished, Passed, Average score, Seat minutes, IP addresses, Locations |
| Sittings | Started, Name, Licence, Email, Phone, State, Course, Completed, Score %, Seat minutes, Certificate, IP address, Location, Device |
| Sign-ins | When, Name, Licence, Email, Phone, State, IP address, Location, Device |

- File name: `ceustamps_{tab}_{from}_to_{to}.csv`. Quote any field containing a
  comma, quote or newline.

### 6.7 Display

- Times in the **viewer's local timezone** (stored as UTC).
- Long course names truncated to one line, full text on hover — otherwise the
  Location column gets pushed off-screen.
- Wide tables scroll inside their own box; the page itself never scrolls sideways.

---

## 7. Security and privacy

The report shows **name, licence number, email, phone, IP address and location**
for every student at once. Treat it accordingly:

1. **Never publicly reachable.** Put it behind authentication or restrict it to
   specific addresses. (The current page opens only on `localhost`, and its API
   refuses any request that came through a proxy.)
2. **Read-only database login** with the column grants in §2.1. Never reuse `ceustamps_app`.
3. **Never select** `sessions.token_hash` or `courses.body`.
4. **Keep the password out of source control.**
5. **Geolocation is a disclosure.** City/state is resolved when a visit is
   recorded, by sending the IP address to `ipwho.is`. That already happened
   upstream — the report app only reads the stored result and must not send
   addresses anywhere itself. Check your privacy policy covers it.

---

## 8. Checking the new app against the current one

Run both on the same range and compare the tiles. These queries compute the
headline numbers directly — set `@from` / `@to` as in §5.1:

```sql
-- Sittings (demo excluded)
SELECT COUNT(*) FROM dbo.sessions
WHERE started_at >= @from AND started_at < @to AND is_demo = 0;

-- Sign-ins
SELECT COUNT(*) FROM dbo.sign_ins
WHERE at >= @from AND at < @to;

-- People
SELECT COUNT(DISTINCT UPPER(TRIM(license_number))) FROM (
  SELECT license_number FROM dbo.sessions
    WHERE started_at >= @from AND started_at < @to AND is_demo = 0
  UNION ALL
  SELECT license_number FROM dbo.sign_ins
    WHERE at >= @from AND at < @to
) AS seen;
```

Reference snapshot, taken 10 Sep 2026 for the UTC window
`2026-09-01T00:00Z` → `2026-09-11T00:00Z`: **8 people, 7 sittings, 4 sign-ins**.
The numbers will grow; the queries above remain the check.

---

## 9. Alternative: read through the existing API instead of the database

The report application does not have to touch the database at all. The live API
already has an endpoint that returns the whole report, with every rule in §5
applied server-side.

| | Direct to database (§2–4) | Through the API (this section) |
|---|---|---|
| Credentials in the report app | SQL login + password | One admin key |
| Firewall rule needed | Yes, for the app's address | No |
| Rules in §5 | You re-implement them | Already applied — same numbers as this report by construction |
| Available today | Yes | **No — needs a deploy and a key (§9.1)** |

### 9.1 Status — live

| Requirement | State on 10 Sep 2026 |
|---|---|
| Endpoint deployed | **Yes.** Production runs commit `83061df` (deployed 10 Sep 2026) |
| `CEU_ADMIN_KEY` set on the `ceustamps-api` Web App | **Yes.** A 43-character random key. Verified: `200` with the key, `404` without it or with a wrong one |
| `x-admin-key` allowed by CORS | **No.** Only matters for a browser caller — see §9.4 |

The key's value is not in this document. Copy it straight to the clipboard on a
machine signed in with `az login`:

```powershell
az webapp config appsettings list -g TradeAlgoResource -n ceustamps-api `
  --query "[?name=='CEU_ADMIN_KEY'].value" -o tsv | Set-Clipboard
```

To change it, set a new value on the Web App and in the report application —
the old one stops working as soon as the API restarts.

### 9.1.1 Either route stays empty until the live site sends data

**This applies to the database route too.** On 10 Sep 2026 the site at
`ceustamps.com` was built **without `VITE_API_BASE`**: its bundle contains no API
address at all, so it runs as the browser-only prototype. A real visitor's
sign-in goes nowhere, and the only rows in `ceustampsdb` are deployment checks.

Connecting it changes **only visit recording**. Sign-ins and visits are the one
thing the site sends to the API; the course engine — timers, questions,
grading, certificates — still runs entirely in the browser and is unaffected.

In order, for real students to appear in either report:

1. **Deploy the API** (`./deploy/deploy-ceustamps.ps1`). Production lacks
   `/api/sign-ins`, so the site would have nowhere to send them. The deploy also
   ships the address-without-port fix (§5.8).
2. **Build the site with** `VITE_API_BASE=https://ceustamps-api.azurewebsites.net`
   — set it in Netlify under *Site settings → Environment variables*, then
   redeploy. It is read at build time, so changing it without a rebuild does nothing.
3. Nothing to change for CORS: `CEU_ALLOWED_ORIGINS` already lists
   `https://ceustamps.com` and `https://www.ceustamps.com`.
4. Optional: set `CEU_GEOIP_URL=https://ipwho.is/{ip}` on the Web App to record
   city and state — a privacy decision (§7.5).

### 9.2 Endpoint

```
GET https://ceustamps-api.azurewebsites.net/api/admin/report?from={from}&to={to}[&demo=1]
x-admin-key: {CEU_ADMIN_KEY}
```

| Parameter | Meaning |
|---|---|
| `from`, `to` | **ISO instants** (recommended) — an exact half-open window, built as in §5.1. Or `YYYY-MM-DD` — read as **UTC** days, `to` inclusive (the server adds a day). |
| `demo=1` | Include demo sittings (§5.3). Omit to exclude them. |

Example:

```bash
curl -H "x-admin-key: $CEU_ADMIN_KEY" \
  "https://ceustamps-api.azurewebsites.net/api/admin/report?from=2026-09-01T07:00:00.000Z&to=2026-09-10T07:00:00.000Z"
```

| Status | Meaning |
|---|---|
| `200` | Report body (§9.3) |
| `400` `bad_range` | A date is missing or invalid, or the end is not after the start |
| `404` `not_found` + `"No such endpoint."` | Missing or wrong key — refused as 404 so the endpoint is not advertised |
| `404` `not_found` with no message | The deployed code does not have the endpoint (today's state) |
| `429` `rate_limited` | More than 120 requests a minute from one address |

### 9.3 Response

```jsonc
{
  "range": { "from": "…Z", "to": "…Z", "includeDemo": false },
  "geoipConfigured": false,          // whether addresses are resolved to places at all
  "totals": {
    "students": 8,                   // People tile
    "signIns": 4,
    "signedInOnly": 1,
    "sessions": 7,                   // Sittings tile
    "completed": 0,
    "certificates": 0,
    "seatMinutes": 0,
    "locationsResolved": 0
  },
  "students": [ /* one per person — Students tab */ ],
  "courses":  [ /* one per course — Courses tab */ ],
  "sessions": [ /* one per sitting — Sittings tab */ ],
  "signIns":  [ /* one per visit — Sign-ins tab */ ]
}
```

| Array | Fields |
|---|---|
| `students` | `licence`, `name`, `email`, `phone`, `state`, `signIns`, `sessions`, `completed`, `courses[]`, `firstSeen`, `lastSeen`, `addresses[]`, `locations[]`, `seatMinutes`, `averageScore` |
| `courses` | `id`, `title`, `state`, `section`, `students`, `sessions`, `completed`, `passed`, `averageScore`, `seatMinutes`, `addresses[]`, `locations[]` |
| `sessions` | `id`, `name`, `licence`, `email`, `phone`, `state`, `courseId`, `course`, `programId`, `section`, `startedAt`, `completedAt`, `seatMinutes`, `scorePercent`, `passed`, `certificate`, `ip`, `location`, `device`, `isDemo` |
| `signIns` | `licence`, `name`, `email`, `phone`, `state`, `at`, `ip`, `location`, `device` |

All times are ISO-8601 UTC. Addresses are returned **raw**, so the display rules in
§5.7 and the port quirk in §5.8 still apply in the report app. Ordering as
returned: `students` by last seen, newest first; `courses` by sittings, most
first; `sessions` and `signIns` oldest first — sort client-side (§6.4).

### 9.4 Call it from a server, not from a browser

The admin key opens every student's name, licence, email, phone and address.
Anything shipped to a browser can be read by whoever opens the page, so the key
must stay on the report application's **server side**, which calls the API and
passes the result to its own pages.

A browser calling the API directly would also fail today: the API's CORS rules
allow only the `content-type` and `authorization` request headers, so the
browser's preflight check refuses `x-admin-key` before the request is sent. The
report app's origin would also have to be added to `CEU_ALLOWED_ORIGINS`.
Server-to-server calls are not subject to CORS and need neither change.

## 10. The RADS10 tab

Added 11 Oct 2026. The page carries a second product beside CEU Stamps; a switch at
the top chooses between them, and `/#rads10` opens this one directly. Everything in
§6 (filters, tiles, tabs, sorting, paging, CSV) works the same way.

### 10.1 Source

`GET /api/report?site=rads10&from=…&to=…` on this site calls
`GET /api/rads10/admin/usage?from=…&to=…` on the API with the same `x-admin-key` as
§9. The API returns every page view in the range (newest first, at most 20,000, with
`truncated` set when there were more) and the clicks through to shops counted per
shop and station. The rules below are applied by this site, in `server/rads10.js`.

### 10.2 Rules

1. **Visitor** — a browser. rads10.com gives each one a random id and keeps it in the
   browser. Two devices are two visitors; clearing the browser starts a new one.
2. **Name** — if any page view of a visitor in the range was logged in to a station or
   shop account, the visitor carries that account's name and type. Otherwise the name
   is "Visitor" and the first eight characters of the id.
3. **Admin** — a visitor with any page view logged in to the RADS10 admin dashboard is
   the owner. Left out of every figure unless "Include admin visits" is ticked; the
   Visits tile says how many were hidden.
4. **Visit** — the page views of one browser session, in the order they were opened.
   Landing page and referrer come from the first; the address from the first that has one.
5. **Time on site** — the seconds each page was on screen, added up. A page that never
   reported back is "not recorded", not zero (as §5 treats a sign-in).
6. **Station** — the station whose page the visitor arrived through, from the site's
   30-day station cookie.
7. **Location** — looked up from the visit's address when the report runs (§5.6), for
   public addresses only. The Places tile counts different places.
8. **Shop clicks** — counted by the API without a visitor or an address, so they are a
   tab of their own and are not affected by rule 3.

### 10.3 Tabs

| Tab | One row per | Opens on |
|---|---|---|
| Visitors | visitor; the Visits count opens that visitor's visits underneath | last seen, newest first |
| Visits | visit | started, newest first |
| Pages | page path | views, most first |
| Shop clicks | shop and station code | clicks, most first |

Tiles: Unique visitors, Visits, Page views, Time on site, Shop clicks, Places.
