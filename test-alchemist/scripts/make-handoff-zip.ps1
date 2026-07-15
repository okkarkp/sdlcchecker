# make-handoff-zip.ps1
# Produces a clean, shareable zip of Test Alchemist for a new project/team.
# EXCLUDES: secrets (.env), runtime data (data/), node_modules, logs, dev-tool config.
# INCLUDES: source, .env.example, docs, package.json/lock, start/stop scripts.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File scripts\make-handoff-zip.ps1

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot      # project root (this script lives in scripts/)
$name    = 'test-alchemist-handoff'
$staging = Join-Path $env:TEMP $name
$zipPath = Join-Path $root "$name.zip"

Write-Host "Project root : $root"

# 1. Stop any running server so nothing (esp. the SQLite DB) is locked.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Write-Host "Stopping server PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. Clean previous staging + zip.
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# 3. Copy project -> staging, excluding secrets / runtime / bulk.
#    /XD = exclude these directory names anywhere; /XF = exclude these file patterns.
$excludeDirs = @(
  'node_modules', '.git', '.claude', '.vscode', 'vscode-bridge',
  'data', '.pwlib-runs', '.pwlib-reports', 'test-results', 'uploads',
  'playwright-report', 'generated'
)
$excludeFiles = @('.env', 'ip-whitelist.txt', '*.log', '*.err', '*.zip')

robocopy $root $staging /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD $excludeDirs /XF $excludeFiles | Out-Null
# robocopy exit codes < 8 mean success (1 = files copied). >= 8 is a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

# 4. Zip the staged copy into the project root, then clean up staging.
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -Force
Remove-Item $staging -Recurse -Force

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Created: $zipPath  ($sizeMB MB)"
Write-Host "Shipped .env.example (NOT .env)."
Write-Host "Recipient steps: npm install  ->  copy .env.example to .env and fill it  ->  start.bat"
