# Prompts for each parameter the local AppHost declares (aspire-apphost/apphost.mts) and saves it in that checkout's
# Aspire user secrets. Aspire keys user secrets by checkout path, so run it once per checkout or worktree.
# Usage: pwsh scripts/set-local-secrets.ps1 [-AppHost <checkout path>]
# Secret values are typed hidden. Enter alone keeps the current value. github-app-key takes the path to the App's .pem.
# Values go straight into secrets.json, never onto a command line, where other processes could read them.
param([string]$AppHost = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'

$src = Get-Content (Join-Path $AppHost 'aspire-apphost/apphost.mts') -Raw
# Secrets are the ones declared through apphost.mts's secret() helper. @() keeps a single match a list.
$secret = @([regex]::Matches($src, "secret\('([\w-]+)'\)") | ForEach-Object { $_.Groups[1].Value })
$plain = @([regex]::Matches($src, "addParameter\('([\w-]+)'") | ForEach-Object { $_.Groups[1].Value })
if (-not ($secret + $plain)) { throw "no parameters found in $AppHost/aspire-apphost/apphost.mts" }

$out = aspire secret path --apphost $AppHost --non-interactive --nologo
if ($LASTEXITCODE) { throw "aspire secret path failed for $AppHost" }
$file = "$($out | Select-Object -Last 1)".Trim()
# Refuse anything but an absolute secrets.json, so a changed CLI output can't send the tokens into the working tree.
if (-not ([IO.Path]::IsPathRooted($file) -and (Split-Path $file -Leaf) -eq 'secrets.json')) { throw "aspire secret path gave '$file', not a secrets.json path" }
$store = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
if (-not $store) { $store = @{} }

"Secrets file: $file"
foreach ($name in $secret + $plain) {
  $key = "Parameters:$name"
  $state = if ($store.ContainsKey($key)) { 'set' } else { 'missing' }
  if ($name -eq 'github-app-key') {
    # Trim the quotes that Explorer's "Copy as path" adds.
    $path = (Read-Host "$name ($state), path to the .pem file").Trim().Trim('"', "'")
    $value = if ($path) { (Get-Content -LiteralPath $path -Raw).Trim() } else { '' }
  } elseif ($secret -contains $name) {
    # NetworkCredential, because ConvertFrom-SecureString throws on the empty input that Enter gives.
    $value = [Net.NetworkCredential]::new('', (Read-Host "$name ($state), hidden" -AsSecureString)).Password
  } else {
    $value = Read-Host "$name ($state)"
  }
  if ($value) { $store[$key] = $value; "  saved" } else { "  kept" }
}

New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
# -Depth 100, because the default depth of 2 flattens other tools' nested entries to a type name.
$store | ConvertTo-Json -Depth 100 | Set-Content $file -Encoding utf8NoBOM
$missing = ($secret + $plain) | Where-Object { -not $store.ContainsKey("Parameters:$_") }
if ($missing) { "Still missing: $($missing -join ', ')" } else { "All $(($secret + $plain).Count) parameters are set." }
