# CEU Stamps usage report

Standalone, read-only report of who uses CEU Stamps: people, the courses they
take, when, and from which address. It never writes anything.

The same page has a second product, **RADS10** (switch at the top, or open
`/#rads10`): how many different visitors rads10.com had, their visits, the pages
they opened and the clicks through to shops. See "The RADS10 tab" below.

- **Live:** https://ceustampsreport.netlify.app
- **Deploys:** Netlify builds `main` of `github.com/ashokkumar9892/CEUStampsReport` on every push.
- **Spec:** [docs/report-requirements.md](docs/report-requirements.md) — tables, rules, page layout. Section numbers (§5.1 etc.) in code comments refer to it.

## How it fits together

```
browser page (public/)  →  Netlify function /api/report (netlify/functions/report.mjs)
                        →  GET https://ceustamps-api.azurewebsites.net/api/admin/report
                           header x-admin-key: <CEU_ADMIN_KEY>
```

The API it reads lives in the sibling repo **`c:\Ashok\Claude Ai Code\CEU-Website`**:

| What | Where in CEU-Website |
|---|---|
| Report aggregation (every rule in §5) | `server/src/service.js` — `report()` |
| The endpoint and its access guard | `server/src/app.js` — `/api/admin/report` |
| SQL it runs | `server/src/stores/sql.js` — `reportSessions`, `reportSignIns` |
| Deploying the API | `deploy/deploy-ceustamps.ps1` (runs its tests first) |
| The original in-app report | `src/components/ReportScreen.jsx` (localhost only) |

## The RADS10 tab

```
browser page  →  /api/report?site=rads10  →  GET https://ceustamps-api.azurewebsites.net/api/rads10/admin/usage
                                             header x-admin-key: <CEU_ADMIN_KEY>   (same key, no new setting)
```

| What | Where |
|---|---|
| Rules: visitor, visit, admin left out, places | `server/rads10.js` here (the API returns raw page views; nothing is aggregated there) |
| The endpoint, and recording a page view | CEU-Website `server/src/rads10/usage.js` |
| Its table | CEU-Website `server/sql/013_rads10_visits.sql` → `dbo.rads10_visits` |
| The script that reports each page | RADS10 repo (`c:\Ashok\Claude Ai Code\RADS10`) `public/app.js` — `reportVisit()` |

- **A visitor is a browser**, a random id rads10.com keeps in `localStorage`. Nobody signs in to browse, so there is no name unless that browser logged in to a station or shop account.
- **A visit** is one browser session (`sessionStorage`); its time on site is the pages' on-screen seconds added up.
- **The owner is left out**: any browser that has the RADS10 admin dashboard logged in is hidden unless "Include admin visits" is ticked.
- **Shop clicks** come from `rads10_clicks`, which has never stored an address or a visitor, so they sit beside the visitors, not under them.
- There is no RADS10 history before the day its site began reporting visits. Shop clicks go back further.

## Settings

Netlify → site **ceustampsreport** → Site configuration → Environment variables.
Values never go in files or commits.

| Variable | Value |
|---|---|
| `REPORT_API_KEY` | `CEU_ADMIN_KEY` on the Azure Web App `ceustamps-api` (resource group `TradeAlgoResource`). Required. |
| `REPORT_AUTH_USER` / `REPORT_AUTH_PASSWORD` | Optional. Set both and every visitor must sign in. |

**The report is open to every address with no sign-in** — the owner removed the IP
restriction on 15 Sep 2026, knowing it exposes every student's contact details to
anyone with the link. Don't re-add a restriction unless asked. `REPORT_ALLOWED_IPS` is
no longer read.

Copy the key to the clipboard without displaying it (needs `az login`):

```powershell
az webapp config appsettings list -g TradeAlgoResource -n ceustamps-api --query "[?name=='CEU_ADMIN_KEY'].value" -o tsv | Set-Clipboard
```

`scripts/copy-report-site-settings.ps1` copies the key and checks the site afterwards.

## Commands

```bash
npm test               # node --test
npm run build:netlify  # what Netlify runs; output in dist/ (git-ignored)
npm start              # local server on 127.0.0.1:5180, reads .env
```

## Rules that have bitten before

- **Dates are UTC instants built from the operator's local days** (§5.1). Sending bare dates made the most recent activity vanish west of Greenwich.
- **A person is `UPPER(TRIM(license_number))`**, not a session and not an address.
- **The admin key must stay server-side.** The API's CORS rules don't allow `x-admin-key` from a browser anyway.
- **Old rows store `ip:port`** (e.g. `98.122.179.148:61347`); `::1` means the visitor was on the API's own machine.

## State as of 13 Sep 2026

- API deployed at commit `83061df`; `CEU_ADMIN_KEY` set and verified.
- ceustamps.com sends **sign-ins only** (`.env.production` sets `VITE_API_BASE`). Enrollments, progress and certificates still run in the browser and never reach the database, so Sittings/Finished/Seat time show only the old deployment-check rows.
- **Time on site** (how long each sign-in visit kept the site visible) is built in CEU-Website `c37a7e7` but **not live yet**. Order to ship: (1) `deploy/apply-migration.ps1 005_visit_time.sql` adds `sign_ins.active_seconds` / `last_active_at`; (2) `deploy/deploy-ceustamps.ps1`; (3) push CEU-Website `main` so Netlify rebuilds ceustamps.com. Deploying the API before step 1 would make every visit's minute ping fail and fill `audit_log` with server errors. Until then the report shows "not recorded".
- City/state lookup on the API (`CEU_GEOIP_URL`) is off, so rows arrive without a location. **The report looks addresses up itself** when it runs (`server/geo.js`: ipwho.is, then db-ip.com free), for public addresses only — owner's request, 15 Sep 2026. `REPORT_GEOIP=off` in Netlify stops it. The lookup must finish inside the function's 10 s limit (API 6.5 s, whole report 8.5 s).

## RADS10 tab: state as of 11 Oct 2026

The tab is live on this site, but **the API and rads10.com are not deployed yet**, so it
shows "does not record RADS10 visits yet". All three parts are committed and tested:
this repo (pushed), CEU-Website `main` (visits merged locally as `5f60bcc`, 107 tests
pass, not pushed), RADS10 `main` (not pushed). Order to ship, each a production change
for the owner to approve:

1. CEU-Website: push `main`, then `deploy/apply-migration.ps1 013_rads10_visits.sql`
   (adds `rads10_visits`). WooCommerce's `010_rads10_woocommerce.sql` may also still need
   applying; check before deploying.
2. CEU-Website: `deploy/deploy-ceustamps.ps1`. GitHub's `main` at `2440001` holds a broken
   merge (Shopify connect and WooCommerce fail); the repair is `aeed354`, local only until
   pushed. Never deploy with `-SkipTests`.
3. RADS10: push `main` so Netlify publishes the page script and the Privacy Policy's new
   "Visits" paragraph. The policy used to say "no analytics trackers"; the owner should
   read the new wording before it goes out.

Pushing step 3 before step 2 is harmless (the pages' reports get a 404 and are ignored).

## Working here

- Deploying the API, changing Azure settings, touching the database, and pushing are production changes — confirm with the owner first.
- The owner likes work committed once it is done and verified.
