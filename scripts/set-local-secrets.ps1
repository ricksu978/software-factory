# Changes the parameters the local AppHost (aspire-apphost/apphost.mts) declares under `aspire run` in that checkout's
# Aspire user secrets. A missing parameter needs no script, because the Aspire dashboard asks for it on `aspire run`
# (issue #207). Aspire keys user secrets by checkout path, so each checkout or worktree has its own.
# Usage: pwsh scripts/set-local-secrets.ps1 [-AppHost <checkout path>] [-MissingOnly]
# Secret values are typed hidden. Enter alone keeps the current value. github-app-key-path takes the path to the App's .pem.
# Values go straight into secrets.json, never onto a command line, where other processes could read them.
# -MissingOnly asks only for parameters not yet set. Nothing calls it now that the dashboard asks. Exits 1 while any is missing.
param([string]$AppHost = (Split-Path $PSScriptRoot -Parent), [switch]$MissingOnly)
$ErrorActionPreference = 'Stop'

$out = aspire secret path --apphost $AppHost --non-interactive --nologo
if ($LASTEXITCODE) { throw "aspire secret path failed for $AppHost" }
$file = "$($out | Select-Object -Last 1)".Trim()
# Refuse anything but an absolute secrets.json, so a changed CLI output can't send the tokens into the working tree.
if (-not ([IO.Path]::IsPathRooted($file) -and (Split-Path $file -Leaf) -eq 'secrets.json')) { throw "aspire secret path gave '$file', not a secrets.json path" }

# src/apphost/local-parameters.ts decides which parameters to ask for and whether the start stops, so the PBI 312
# scenarios hold the same decisions this script acts on. It checks only which keys secrets.json holds, and prints no
# value. It takes only the parameters the AppHost declares under `aspire run`, so never the published BFF's oidc-issuer
# or oidc-client-secret. Secrets are the ones declared through apphost.mts's secret() helper. @() keeps one line a list.
$check = Join-Path $PSScriptRoot '../src/apphost/local-parameters.ts'
$toAsk = if ($MissingOnly) { @(node $check $AppHost --ask $file) } else { @(node $check $AppHost) }
if ($LASTEXITCODE) { throw "could not read the parameters $AppHost/aspire-apphost/apphost.mts declares" }
$store = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
if (-not $store) { $store = @{} }

"Secrets file: $file"
$changed = $false
foreach ($line in $toAsk) {
  $kind, $name = $line -split ' ', 2
  $key = "Parameters:$name"
  $state = if ($store.ContainsKey($key)) { 'set' } else { 'missing' }
  if ($kind -eq 'secret') {
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
# "Still missing: ..." and exit 1, or "All N parameters are set." and exit 0, as local-parameters.ts decides.
node $check $AppHost --verdict $file
exit $LASTEXITCODE
