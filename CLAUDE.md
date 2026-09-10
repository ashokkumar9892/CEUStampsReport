# CEU Stamps usage report

Standalone, read-only report of who uses CEU Stamps: people, the courses they
take, when, and from which address. It never writes anything.

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

## Settings

Netlify → site **ceustampsreport** → Site configuration → Environment variables.
Values never go in files or commits.

| Variable | Value |
|---|---|
| `REPORT_API_KEY` | `CEU_ADMIN_KEY` on the Azure Web App `ceustamps-api` (resource group `TradeAlgoResource`). Required. |
| `REPORT_ALLOWED_IPS` | Addresses that open the report with no sign-in, comma-separated. The owner's address was `98.122.179.148` on 10 Sep 2026; residential addresses change. |
| `REPORT_AUTH_USER` / `REPORT_AUTH_PASSWORD` | Optional sign-in for everyone else. |

Copy the key to the clipboard without displaying it (needs `az login`):

```powershell
az webapp config appsettings list -g TradeAlgoResource -n ceustamps-api --query "[?name=='CEU_ADMIN_KEY'].value" -o tsv | Set-Clipboard
```

`scripts/copy-report-site-settings.ps1` walks through both settings and checks the site afterwards.

## Commands

```bash
npm test               # node --test
npm run build:netlify  # what Netlify runs; output in dist/ (git-ignored)
npm start              # local server on 127.0.0.1:5180, reads .env
```

## Rules that have bitten before

- **Access comes from `context.ip` only**, never `X-Forwarded-For` or any other header — a visitor can set headers to anything. The 403 names the address the site saw, which is how the owner finds a changed address.
- **Dates are UTC instants built from the operator's local days** (§5.1). Sending bare dates made the most recent activity vanish west of Greenwich.
- **A person is `UPPER(TRIM(license_number))`**, not a session and not an address.
- **The admin key must stay server-side.** The API's CORS rules don't allow `x-admin-key` from a browser anyway.
- **Old rows store `ip:port`** (e.g. `98.122.179.148:61347`); `::1` means the visitor was on the API's own machine.

## State as of 10 Sep 2026

- API deployed at commit `83061df`; `CEU_ADMIN_KEY` set and verified.
- **The main site ceustamps.com is not connected to the API** — it was built without `VITE_API_BASE`, so real visitors' sign-ins are not recorded and the database holds only deployment test rows. Fixing that is in CEU-Website: set `VITE_API_BASE=https://ceustamps-api.azurewebsites.net` on the main site in Netlify and redeploy. It changes visit recording only; courses and grading run in the browser.
- City/state lookup (`CEU_GEOIP_URL`) is deliberately off.

## Working here

- Deploying the API, changing Azure settings, touching the database, and pushing are production changes — confirm with the owner first.
- The owner likes work committed once it is done and verified.
