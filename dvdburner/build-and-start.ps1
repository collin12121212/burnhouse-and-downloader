<#
.SYNOPSIS
    Build Burnhouse and start it.

.DESCRIPTION
    There is no compile step in this project - the editor is plain HTML, CSS and
    JavaScript that the browser loads directly - so "building" means three things:

      1. the dependencies are installed (Electron itself);
      2. the disc tools are present, which is what actually lets the app build a
         playable DVD: ffmpeg, ffprobe, dvdauthor and spumux;
      3. nothing stale is left running.

    Then it starts the app and confirms the window came up.

    The Mac build is a separate thing and is not done here: GitHub Actions runs
    on a macOS machine, bundles the tools into the app, and produces the .dmg.
    See .github/workflows/build-mac.yml.

.PARAMETER Reinstall
    Run npm install even if node_modules already looks complete.

.PARAMETER NoStart
    Do the build and the checks, but do not launch the app.

.EXAMPLE
    .\build-and-start.ps1
    .\build-and-start.ps1 -Reinstall
    .\build-and-start.ps1 -NoStart
#>

[CmdletBinding()]
param(
    [switch]$Reinstall,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step($text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Cyan
}

function Write-Ok($text)   { Write-Host "   ok      $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "   warn    $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "   MISSING $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "           $text" -ForegroundColor DarkGray }

Write-Host ''
Write-Host 'Burnhouse - build and start' -ForegroundColor White

# --------------------------------------------------------------- node / npm ---
Write-Step 'Checking the toolchain'

foreach ($tool in @('node', 'npm')) {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Bad "$tool is not on PATH"
        Write-Info 'Install Node.js from https://nodejs.org and run this again.'
        exit 1
    }
}
Write-Ok "node $(node --version)"
Write-Ok "npm  $(npm --version)"

# ------------------------------------------------------------- dependencies ---
Write-Step 'Dependencies'

$electronExe = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
$needsInstall = $Reinstall -or -not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))

if ($needsInstall) {
    Write-Info 'Running npm install... (this can take a few minutes the first time)'
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Bad 'npm install failed; see the output above.'
        exit 1
    }
    Write-Ok 'dependencies installed'
} else {
    Write-Ok 'node_modules already present'
}

# Electron's own postinstall downloads a ~100 MB binary, and on a locked-down
# machine that step can be blocked. The download is usually still in Electron's
# cache, so it can be unpacked from there rather than fetched again.
if (-not (Test-Path $electronExe)) {
    Write-Warn 'the Electron binary is missing; trying the download cache'

    $dist = Join-Path $PSScriptRoot 'node_modules\electron\dist'
    $cache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
    $zip = $null
    if (Test-Path $cache) {
        $zip = Get-ChildItem $cache -Filter 'electron-v*-win32-*.zip' -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending |
               Select-Object -First 1
    }

    if ($zip) {
        Write-Info "unpacking $($zip.Name)"
        New-Item -ItemType Directory -Force -Path $dist | Out-Null
        Expand-Archive -LiteralPath $zip.FullName -DestinationPath $dist -Force
    }

    if (-not (Test-Path $electronExe)) {
        Write-Bad 'the Electron binary could not be installed'
        Write-Info 'Run: npm install electron --force'
        Write-Info 'Or unpack electron-v31.7.7-win32-x64.zip into node_modules\electron\dist'
        exit 1
    }
    Write-Ok 'Electron unpacked from the cache'
}
Write-Ok 'Electron binary present'

# -------------------------------------------------------------- disc tools ---
# This is the part that decides whether the app can actually make a disc, so it
# is worth reporting in full rather than discovering it later.
Write-Step 'Disc tools'

$probe = & node -e @'
const t = require('./src/core/tools').detectTools({});
const out = {
  ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, dvdauthor: t.dvdauthor, spumux: t.spumux,
  canEncode: t.canEncode, canAuthor: t.canAuthor, canBurn: t.canBurn,
  backend: t.burnBackend, platform: t.platform,
};
process.stdout.write(JSON.stringify(out));
'@ 2>&1

try {
    $tools = $probe | ConvertFrom-Json
} catch {
    Write-Bad 'the tool check did not return anything usable'
    Write-Info $probe
    exit 1
}

foreach ($name in @('ffmpeg', 'ffprobe', 'dvdauthor', 'spumux')) {
    if ($tools.$name) { Write-Ok "$name  $($tools.$name)" }
    else              { Write-Bad "$name" }
}

Write-Host ''
if ($tools.canEncode) { Write-Ok 'can read and encode video' }
else                  { Write-Bad 'cannot read or encode video (needs ffmpeg)' }

if ($tools.canAuthor) { Write-Ok 'can build a DVD-Video disc' }
else                  { Write-Bad 'cannot build a disc (needs dvdauthor and spumux)' }

if ($tools.canBurn)   { Write-Ok "can write a disc ($($tools.backend))" }
else                  { Write-Warn 'cannot write a disc on this computer' }

if (-not $tools.canAuthor) {
    Write-Host ''
    Write-Warn 'Without dvdauthor and spumux the app will design and test a disc'
    Write-Info 'but cannot produce one. On Windows they come from a program that'
    Write-Info 'ships them - DVD Styler, or "GUI for dvdauthor" - and Burnhouse'
    Write-Info 'finds them in that program folder automatically. Otherwise copy'
    Write-Info 'dvdauthor.exe and spumux.exe into:'
    Write-Info "  $env:LOCALAPPDATA\Burnhouse\bin"
}

# ------------------------------------------------------------------- start ---
if ($NoStart) {
    Write-Host ''
    Write-Host 'Build finished. The app was not started (-NoStart).' -ForegroundColor White
    exit 0
}

Write-Step 'Starting'

# The app takes a single-instance lock, so a second copy would quietly hand over
# to the first and the new code would never load. Stop what is running first.
$running = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($running) {
    Write-Info "stopping $($running.Count) running Electron process(es)"
    $running | ForEach-Object { try { $_.Kill() } catch {} }
    Start-Sleep -Seconds 3
}

$app = Start-Process -FilePath $electronExe -ArgumentList '.' -PassThru -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 12

$alive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if (-not $alive) {
    Write-Bad 'the app started and then exited. Run it in the foreground to see why:'
    Write-Info "  & '$electronExe' ."
    exit 1
}

$window = Get-Process -Name electron -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowTitle } |
          Select-Object -First 1

if ($window) {
    $title = $window.MainWindowTitle
    Write-Ok "Burnhouse is running - pid $($window.Id), window '$title'"
} else {
    Write-Warn "a process is running (pid $($app.Id)) but no window title was reported yet"
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor White
