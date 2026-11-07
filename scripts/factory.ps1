# Starts the local factory in one step (plan Task 18): the latest main, Docker, the AppHost's secrets, the cell image,
# then `aspire run`. Usage: npm run factory. Ctrl+C stops it, and Postgres and Azurite keep their data in Aspire's volumes.
# The control resource's console shows the dashboard's sign-in link.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# Only fast-forwards, and only on main, so work on another branch is never touched.
$branch = git branch --show-current
if ($branch -eq 'main') {
  git pull --ff-only
  if ($LASTEXITCODE) { throw "git pull --ff-only failed. Git's message above says why." }
} else {
  Write-Warning "On branch '$branch', not main, so it runs as it is."
}

# Cells, Postgres and Azurite all run in Docker.
docker version *> $null
if ($LASTEXITCODE) {
  $exe = @("$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe", "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) { throw 'Docker is not running, and Docker Desktop is not installed where this looks. Start Docker first.' }
  'Starting Docker Desktop...'
  Start-Process $exe
  $deadline = (Get-Date).AddMinutes(3)
  do { Start-Sleep -Seconds 3; docker version *> $null } while ($LASTEXITCODE -and (Get-Date) -lt $deadline)
  if ($LASTEXITCODE) { throw 'Docker did not come up within 3 minutes.' }
}

# Aspire keys secrets by checkout path, so a fresh checkout has none. This asks only for what's missing.
& "$PSScriptRoot/set-local-secrets.ps1" -MissingOnly
if ($LASTEXITCODE) { throw 'Some AppHost parameters are still missing, and the factory waits on them forever.' }

# Cells run factory-cell:local, so it's rebuilt from this checkout. Docker's cache makes an unchanged build quick.
'Building factory-cell:local...'
docker build -q -f cell/Dockerfile -t factory-cell:local . | Out-Null
if ($LASTEXITCODE) { throw 'Building factory-cell:local failed.' }

aspire run
