<#
.SYNOPSIS
  Puts the report site's three Netlify settings on your clipboard, one at a
  time, so you can paste them in without any of them being shown or saved.

.DESCRIPTION
  The CEUStampsReport site on Netlify needs three environment variables before
  its /api/report answers with data:

    REPORT_API_KEY        the ceustamps-api Web App's CEU_ADMIN_KEY
    REPORT_AUTH_USER      the name you sign in to the report site with
    REPORT_AUTH_PASSWORD  the password you sign in with

  This copies each in turn and waits while you paste it. The admin key is read
  from Azure (needs `az login`); the password is generated fresh. Neither is
  printed or written to disk, and the clipboard is cleared at the end. The key
  and password are also kept out of Windows clipboard history (Win+V) and cloud
  clipboard sync, which clearing the clipboard would not undo.

  Run it in your own PowerShell window -- it pauses for you between steps.

  Lost the password later? Run this again: it makes a new one, and you paste
  that over the old value and redeploy. The admin key stays the same.

.EXAMPLE
  ./scripts/copy-report-site-settings.ps1
  ./scripts/copy-report-site-settings.ps1 -User ceu-admin
#>

[CmdletBinding()]
param(
  # Sent as "user:password" when signing in, so it cannot contain a colon.
  [ValidatePattern('^[^:\s]+$')]
  [string] $User = 'ashok'
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

Write-Host ''
Write-Host '  Report site settings for Netlify' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------------'
Write-Host '  In Netlify open your REPORT site (ceustampsreport, not ceustamps.com):'
Write-Host '    Site configuration -> Environment variables -> Add a variable'
Write-Host '  For each one below: type the Key, paste the Value, leave the scopes'
Write-Host '  as "All scopes" (the report runs as a Function and needs them), Create.'
Write-Host ''

# --- 1. admin key ------------------------------------------------------------

$key = (az webapp config appsettings list -g TradeAlgoResource -n ceustamps-api `
  --query "[?name=='CEU_ADMIN_KEY'].value" -o tsv) -join ''
if ($LASTEXITCODE -ne 0 -or -not $key.Trim()) {
  throw 'Could not read CEU_ADMIN_KEY from the ceustamps-api Web App. Run "az login" and try again.'
}
Set-PrivateClipboard $key.Trim()
Write-Host "  1) REPORT_API_KEY - the admin key ($($key.Trim().Length) characters) is on your clipboard."
Remove-Variable key
Wait-Paste 'REPORT_API_KEY'

# --- 2. user -----------------------------------------------------------------

Set-PrivateClipboard $User
Write-Host "  2) REPORT_AUTH_USER - '$User' is on your clipboard."
Wait-Paste 'REPORT_AUTH_USER'

# --- 3. password -------------------------------------------------------------

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
# 24 random bytes -> 32 characters, letters, digits, - and _ only: nothing that
# needs escaping in Netlify's field or in a browser's sign-in box.
$password = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')
Set-PrivateClipboard $password
Write-Host '  3) REPORT_AUTH_PASSWORD - a new 32-character password is on your clipboard.'
Wait-Paste 'REPORT_AUTH_PASSWORD'

# Without this the password only ever lived on the clipboard, and you would have
# no way to sign in to the site you just protected with it.
Set-PrivateClipboard $password
Write-Host ''
Write-Host '  Save that same password now - your password manager, or your browser' -ForegroundColor Yellow
Write-Host '  when it offers to remember it for the report site. It is on your' -ForegroundColor Yellow
Write-Host '  clipboard again.' -ForegroundColor Yellow
Read-Host '   Press Enter once it is saved' | Out-Null
Remove-Variable password, bytes

[System.Windows.Forms.Clipboard]::Clear()
Write-Host ''
Write-Host '  Clipboard cleared.' -ForegroundColor Green

# --- 4. redeploy and check ---------------------------------------------------

Write-Host ''
Write-Host '  Last step in Netlify: Deploys -> Trigger deploy -> Deploy site.'
Write-Host '  Settings only reach the report function after a redeploy.'
Read-Host '   Press Enter once that deploy shows "Published"' | Out-Null

# Asks without signing in: a configured site answers 401 (password required),
# an unconfigured one 500. No student data is requested or returned either way.
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 `
    "$site/api/report?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z" | Out-Null
  $status = 200
} catch {
  $status = if ($_.Exception.Response) { [int] $_.Exception.Response.StatusCode } else { 0 }
}

Write-Host ''
switch ($status) {
  401 { Write-Host "  Done. Open $site and sign in as '$User'." -ForegroundColor Green }
  500 { Write-Host '  The site still says it is not configured. Check the three names are exactly as above, then redeploy again.' -ForegroundColor Yellow }
  default { Write-Host "  Could not confirm (the site answered $status). Open $site to check." -ForegroundColor Yellow }
}
Write-Host ''
