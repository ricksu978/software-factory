# Starts the local factory in one step (plan Task 18): the latest main and Docker, then `aspire run`, whose cell-image
# resource builds factory-cell:local from this checkout before the worker starts (PBI 206). Usage: npm run factory.
# Ctrl+C stops it, and Postgres and Azurite keep their data in Aspire's volumes. The Aspire dashboard asks for any
# AppHost parameter this checkout has no value for (issue #207), and the control resource's console shows the factory
# dashboard's sign-in link.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# Only fast-forwards, and only on main, so work on another branch is never touched. The AppHost runs the same pull and
# Docker check itself (PBI 205, src/apphost/start.ts), but this script runs them first so a failed pull or a missing
# Docker shows before `aspire run` starts.
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

aspire run
