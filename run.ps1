param([switch]$Again)
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js was not found. Install the LTS version from https://nodejs.org, then run this again." -ForegroundColor Red
  exit 1
}

$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 20) {
  Write-Host "Node.js 20 or newer is required (you have $(node -v)). Update from https://nodejs.org" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies (first run only)..."
  if (Test-Path "package-lock.json") { npm.cmd ci } else { npm.cmd install }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed. Check your internet connection and try again." -ForegroundColor Red
    exit 1
  }
}

$extra = @()
if ($Again) { $extra += "--again" }
npx.cmd tsx main.mts @extra
exit $LASTEXITCODE