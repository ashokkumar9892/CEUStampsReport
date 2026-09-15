<#
.SYNOPSIS
  Puts the report site's Netlify setting on your clipboard, then checks the
  site answers.

.DESCRIPTION
  The CEUStampsReport site on Netlify needs one environment variable before its
  /api/report answers with data:

    REPORT_API_KEY  the ceustamps-api Web App's CEU_ADMIN_KEY

  The report is open to every address with no sign-in. To lock it again, add
  REPORT_AUTH_USER and REPORT_AUTH_PASSWORD in Netlify and redeploy.

  The admin key is read from Azure (needs `az login`). It is never printed or
  written to disk, and it is kept out of Windows clipboard history (Win+V) and
  cloud clipboard sync, which clearing the clipboard afterwards would not undo.

  Run it in your own PowerShell window -- it pauses for you between steps.

.EXAMPLE
  ./scripts/copy-report-site-settings.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$site = 'https://ceustampsreport.netlify.app'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'The Azure CLI (az) is not installed. Install it, run "az login", then run this again.'
}

Add-Type -AssemblyName System.Windows.Forms
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  throw 'Run this in Windows PowerShell (powershell.exe), or start PowerShell 7 with "pwsh -STA": the clipboard calls it needs are unavailable here.'
}

# Windows keeps what is copied in clipboard history (Win+V) and may sync it to
# your other devices; clearing the clipboard afterwards removes neither copy.
# These extra formats ask Windows to leave this content out of both.
function Set-PrivateClipboard([string] $text) {
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $text)
  $never = [BitConverter]::GetBytes([int] 0)
  foreach ($format in 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard', 'ExcludeClipboardContentFromMonitorProcessing') {
    $data.SetData($format, [System.IO.MemoryStream]::new($never))
  }
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
}

Write-Host ''
Write-Host '  Report site setting for Netlify' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------------'
Write-Host '  In Netlify open your REPORT site (ceustampsreport, not ceustamps.com):'
Write-Host '    Site configuration -> Environment variables -> Add a variable'
Write-Host '  Type the Key, paste the Value, leave the scopes as "All scopes"'
Write-Host '  (the report runs as a Function and needs them), Create.'
Write-Host ''

# --- 1. admin key --------------------------------------------------------------

$key = (az webapp config appsettings list -g TradeAlgoResource -n ceustamps-api `
  --query "[?name=='CEU_ADMIN_KEY'].value" -o tsv) -join ''
if ($LASTEXITCODE -ne 0 -or -not $key.Trim()) {
  throw 'Could not read CEU_ADMIN_KEY from the ceustamps-api Web App. Run "az login" and try again.'
}
Set-PrivateClipboard $key.Trim()
Write-Host "  1) REPORT_API_KEY - the admin key ($($key.Trim().Length) characters) is on your clipboard."
Remove-Variable key
Read-Host '   Paste it as the value of REPORT_API_KEY in Netlify, then press Enter here' | Out-Null

[System.Windows.Forms.Clipboard]::Clear()
Write-Host ''
Write-Host '  Clipboard cleared.' -ForegroundColor Green
Write-Host '  REPORT_ALLOWED_IPS is no longer used - you can delete it. Leave'
Write-Host '  REPORT_AUTH_USER / REPORT_AUTH_PASSWORD unset for an open report;'
Write-Host '  with both set, every visitor is asked to sign in.'

# --- 2. redeploy and check -----------------------------------------------------

Write-Host ''
Write-Host '  Last step in Netlify: Deploys -> Trigger deploy -> Deploy site.'
Write-Host '  Settings only reach the report function after a redeploy.'
Read-Host '   Press Enter once that deploy shows "Published"' | Out-Null

# A one-day window in January: the answer says whether the site is set up,
# without pulling any real student's details down.
$message = ''
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 `
    "$site/api/report?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z" | Out-Null
  $status = 200
} catch {
  $status = if ($_.Exception.Response) { [int] $_.Exception.Response.StatusCode } else { 0 }
  $message = "$($_.ErrorDetails.Message)"
}

Write-Host ''
switch ($status) {
  200 { Write-Host "  Done. Open $site - it opens for anyone, with no sign-in." -ForegroundColor Green }
  401 { Write-Host '  The site asked for a sign-in: REPORT_AUTH_USER and REPORT_AUTH_PASSWORD are set. Delete them and redeploy for an open report.' -ForegroundColor Yellow }
  500 { Write-Host "  The site still says it is not configured: $message" -ForegroundColor Yellow }
  default { Write-Host "  Could not confirm (the site answered $status). Open $site to check." -ForegroundColor Yellow }
}
Write-Host ''
