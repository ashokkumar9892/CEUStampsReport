<#
.SYNOPSIS
  Puts the report site's two Netlify settings on your clipboard, one at a time,
  then checks the site opens from this machine.

.DESCRIPTION
  The CEUStampsReport site on Netlify needs two environment variables before
  its /api/report answers with data:

    REPORT_API_KEY      the ceustamps-api Web App's CEU_ADMIN_KEY
    REPORT_ALLOWED_IPS  the addresses that may open the report, with no sign-in

  This copies each in turn and waits while you paste it. The admin key is read
  from Azure (needs `az login`); it is never printed or written to disk, and it
  is kept out of Windows clipboard history (Win+V) and cloud clipboard sync,
  which clearing the clipboard afterwards would not undo.

  Your address is this machine's current public address, looked up at
  api.ipify.org. Pass -Address to use a different one.

  Run it in your own PowerShell window -- it pauses for you between steps.

  If your internet provider later changes your address, the site's refusal
  message names the new one: put it in REPORT_ALLOWED_IPS and redeploy.

.EXAMPLE
  ./scripts/copy-report-site-settings.ps1
  ./scripts/copy-report-site-settings.ps1 -Address 98.122.179.148
#>

[CmdletBinding()]
param(
  [string] $Address
)

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

function Wait-Paste([string] $name) {
  Read-Host "   Paste it as the value of $name in Netlify, then press Enter here" | Out-Null
}

# --- your address, before anything is pasted ----------------------------------

if (-not $Address) {
  try {
    $Address = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 15).ToString().Trim()
  } catch {
    throw 'Could not look up this machine''s public address. Run again with -Address <your address>.'
  }
}
$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($Address, [ref] $parsed)) {
  throw "'$Address' is not an IP address."
}

Write-Host ''
Write-Host '  Report site settings for Netlify' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------------'
Write-Host '  In Netlify open your REPORT site (ceustampsreport, not ceustamps.com):'
Write-Host '    Site configuration -> Environment variables -> Add a variable'
Write-Host '  For each one below: type the Key, paste the Value, leave the scopes'
Write-Host '  as "All scopes" (the report runs as a Function and needs them), Create.'
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
Wait-Paste 'REPORT_API_KEY'

# --- 2. your address -----------------------------------------------------------

Set-PrivateClipboard $Address
Write-Host "  2) REPORT_ALLOWED_IPS - your address, $Address, is on your clipboard."
Write-Host '     (To allow more than one place later, separate addresses with commas.)'
Wait-Paste 'REPORT_ALLOWED_IPS'

[System.Windows.Forms.Clipboard]::Clear()
Write-Host ''
Write-Host '  Clipboard cleared.' -ForegroundColor Green
Write-Host '  If REPORT_AUTH_USER / REPORT_AUTH_PASSWORD were added earlier, you can'
Write-Host '  delete them: with both set, other addresses get a sign-in prompt instead'
Write-Host '  of being refused. Either way this address opens straight in.'

# --- 3. redeploy and check -----------------------------------------------------

Write-Host ''
Write-Host '  Last step in Netlify: Deploys -> Trigger deploy -> Deploy site.'
Write-Host '  Settings only reach the report function after a redeploy.'
Read-Host '   Press Enter once that deploy shows "Published"' | Out-Null

# A one-day window in January: the answer says whether this machine is let in,
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
  200 { Write-Host "  Done. Open $site - it opens from this machine with no sign-in." -ForegroundColor Green }
  403 { Write-Host "  The site refused this machine: $message" -ForegroundColor Yellow }
  401 { Write-Host '  The site asked for a sign-in, so it did not see this machine as listed. Check REPORT_ALLOWED_IPS matches the address above.' -ForegroundColor Yellow }
  500 { Write-Host "  The site still says it is not configured: $message" -ForegroundColor Yellow }
  default { Write-Host "  Could not confirm (the site answered $status). Open $site to check." -ForegroundColor Yellow }
}
Write-Host ''
