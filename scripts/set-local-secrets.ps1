# Changes the parameters the local AppHost declares (aspire-apphost/apphost.mts) in that checkout's Aspire user
# secrets. A missing parameter needs no script, because the Aspire dashboard asks for it on `aspire run` (issue #207).
# Aspire keys user secrets by checkout path, so each checkout or worktree has its own.
# Usage: pwsh scripts/set-local-secrets.ps1 [-AppHost <checkout path>]
# Secret values are typed hidden. Enter alone keeps the current value.
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
$changed = $false
foreach ($name in $secret + $plain) {
  $key = "Parameters:$name"
  $state = if ($store.ContainsKey($key)) { 'set' } else { 'missing' }
  if ($secret -contains $name) {
    # NetworkCredential, because ConvertFrom-SecureString throws on the empty input that Enter gives.
    $value = [Net.NetworkCredential]::new('', (Read-Host "$name ($state), hidden" -AsSecureString)).Password
  } else {
    $value = Read-Host "$name ($state)"
  }
  if ($value) { $store[$key] = $value; $changed = $true; "  saved" } else { "  kept" }
}

# Written only when a value changed, so a run that asks nothing never rewrites the live token file.
if ($changed) {
  New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
  # -Depth 100, because the default depth of 2 flattens other tools' nested entries to a type name.
  $store | ConvertTo-Json -Depth 100 | Set-Content $file -Encoding utf8NoBOM
}
