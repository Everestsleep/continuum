# continuum installer for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/Everestsleep/continuum/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo       = if ($env:CONTINUUM_REPO)   { $env:CONTINUUM_REPO }   else { 'Everestsleep/continuum' }
$Branch     = if ($env:CONTINUUM_BRANCH) { $env:CONTINUUM_BRANCH } else { 'main' }
$InstallDir = if ($env:CONTINUUM_DIR)    { $env:CONTINUUM_DIR }    else { Join-Path $HOME '.continuum' }

function Say($msg) { Write-Host "[continuum] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "[continuum] error: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die 'Node.js 18+ required. Install from https://nodejs.org'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die 'npm required.'
}

$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) { Die "Node 18+ required (have $(& node -v))" }

if (Get-Command git -ErrorAction SilentlyContinue) {
    if (Test-Path (Join-Path $InstallDir '.git')) {
        Say "Updating $InstallDir..."
        git -C $InstallDir fetch --quiet origin $Branch
        git -C $InstallDir reset --hard "origin/$Branch" --quiet
    } else {
        Say "Cloning $Repo into $InstallDir..."
        if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
        git clone --depth 1 --branch $Branch "https://github.com/$Repo.git" $InstallDir --quiet
    }
} else {
    Say 'Downloading zip...'
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
    $zip = Join-Path $env:TEMP 'continuum.zip'
    Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
    $extracted = Join-Path $env:TEMP "continuum-$Branch"
    Copy-Item -Path "$extracted/*" -Destination $InstallDir -Recurse -Force
    Remove-Item $zip
    Remove-Item -Recurse -Force $extracted
}

Say 'Installing dependencies...'
Push-Location $InstallDir
try {
    & npm install --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }
    Say 'Building...'
    & npm run build --silent
    if ($LASTEXITCODE -ne 0) { Die 'build failed' }
} finally {
    Pop-Location
}

# Create a .cmd shim in a user-writable bin dir
$BinDir = Join-Path $HOME '.continuum\bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$Shim = Join-Path $BinDir 'continuum.cmd'
$JsPath = Join-Path $InstallDir 'dist\cli.js'

@"
@echo off
node "$JsPath" %*
"@ | Set-Content -Path $Shim -Encoding ASCII

Say "Installed shim: $Shim"

# Add to PATH (user) if not already
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
    Say "Adding $BinDir to user PATH..."
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
    Write-Host "[continuum] note: open a new PowerShell window for PATH to take effect." -ForegroundColor Yellow
}

Say 'Done. Try:  continuum --help'
