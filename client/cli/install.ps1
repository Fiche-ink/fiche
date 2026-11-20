# fiche installer for Windows.
#
#   irm https://fiche.ink/install.ps1 | iex
#
# This is the download route without a certificate. fiche has no code signing certificate, so the
# usual setup .exe makes Windows SmartScreen warn before it will run. This script downloads the
# zip build with PowerShell instead, checks its SHA-256 against the release's SHA256SUMS, unpacks
# it to %LOCALAPPDATA%\Programs\fiche and registers it, so nothing has to be run from Explorer.
#
# Settings (environment variables, so they also work through `irm | iex`):
#   FICHE_DIR            install folder     (default %LOCALAPPDATA%\Programs\fiche)
#   FICHE_VERSION        release tag, e.g. v1.0.1 (default: the latest release)
#   FICHE_BASE_URL       where to fetch from: a URL or a local folder
#   FICHE_NO_DESKTOP     1 = no desktop shortcut
#   FICHE_NO_AUTOSTART   1 = do not start fiche with Windows
#   FICHE_NO_START       1 = do not start fiche now
param()

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'Fiche-ink/fiche'
if ($env:FICHE_REPO) { $repo = $env:FICHE_REPO }
$dir = Join-Path $env:LOCALAPPDATA 'Programs\fiche'
if ($env:FICHE_DIR) { $dir = $env:FICHE_DIR }
$asset = 'fiche-win-x64.zip'
if ($env:FICHE_BASE_URL) { $base = $env:FICHE_BASE_URL }
elseif ($env:FICHE_VERSION) { $base = "https://github.com/$repo/releases/download/$($env:FICHE_VERSION)" }
else { $base = "https://github.com/$repo/releases/latest/download" }

function Say($m) { Write-Host "fiche: $m" }
function Die($m) { Write-Host "fiche: $m" -ForegroundColor Red; exit 1 }

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Say 'ARM64 Windows: the x64 build runs under emulation.'
}

$tmp = Join-Path $env:TEMP ("fiche-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  # ---- download (a local folder is allowed, which is how CI tests this script) ----
  $isLocal = -not ($base -match '^https?://')
  $localBase = $base -replace '^file:///?', ''
  function Grab($name, $required) {
    $to = Join-Path $tmp $name
    if ($isLocal) {
      $from = Join-Path $localBase $name
      if (-not (Test-Path $from)) { if ($required) { Die "not found: $from" } else { return $null } }
      Copy-Item $from $to -Force
    } else {
      try { Invoke-WebRequest -Uri "$base/$name" -OutFile $to -UseBasicParsing }
      catch { if ($required) { Die "could not download $base/$name" } else { return $null } }
    }
    return $to
  }

  Say "downloading $asset"
  $zip = Grab $asset $true
  Unblock-File $zip -ErrorAction SilentlyContinue

  $sums = Grab 'SHA256SUMS' $false
  if ($sums) {
    $want = (Select-String -Path $sums -Pattern ([regex]::Escape($asset) + '$') | Select-Object -First 1)
    if ($want) {
      $wantHash = ($want.Line -split '\s+')[0].ToLower()
      $gotHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
      if ($wantHash -ne $gotHash) { Die "checksum mismatch`n  expected $wantHash`n  got      $gotHash" }
      Say 'sha256 ok'
    } else { Say "SHA256SUMS has no line for $asset; skipping the check" }
  } else { Say 'SHA256SUMS was not published with this release; skipping the check' }

  # ---- stop a running copy so its files can be replaced ----
  $exe = Join-Path $dir 'fiche.exe'
  if (Test-Path $exe) {
    try { Start-Process $exe -ArgumentList '--quit' | Out-Null } catch { }
    for ($i = 0; $i -lt 20; $i++) {
      $live = @(Get-Process fiche -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
      if ($live.Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    }
    @(Get-Process fiche -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }

  # ---- unpack ----
  $stage = Join-Path $tmp 'app'
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  $root = $stage
  if (-not (Test-Path (Join-Path $root 'fiche.exe'))) {
    $inner = @(Get-ChildItem $stage -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'fiche.exe') }) | Select-Object -First 1
    if (-not $inner) { Die 'the archive does not look like a fiche build (no fiche.exe)' }
    $root = $inner.FullName
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # Files an older version left behind but this one no longer ships.
  $keep = @(Get-ChildItem $root -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length).ToLower() })
  foreach ($f in @(Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue)) {
    $rel = $f.FullName.Substring($dir.Length).ToLower()
    if ($keep -notcontains $rel) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }
  }
  Copy-Item (Join-Path $root '*') $dir -Recurse -Force
  $ver = 'unknown'
  try { $ver = (Get-Item $exe).VersionInfo.ProductVersion } catch { }
  Say "installed $ver in $dir"

  # ---- register: Installed apps entry and shortcuts, written by the app itself ----
  $regArgs = @('--register-install')
  if ($env:FICHE_NO_DESKTOP -ne '1') { $regArgs += '--desktop' }
  $p = Start-Process $exe -ArgumentList $regArgs -PassThru -Wait
  if ($p.ExitCode -ne 0) { Say "registering returned $($p.ExitCode)" }

  if ($env:FICHE_NO_START -ne '1') {
    $startArgs = @()
    if ($env:FICHE_NO_AUTOSTART -ne '1') { $startArgs += '--autostart=1' }
    Start-Process $exe -ArgumentList $startArgs | Out-Null
    Say 'started'
  }

  Write-Host ''
  Write-Host '  fiche is in your Start menu. Open it and click Sign in; nothing is compressed until you do.'
  Write-Host '  Claude Code is connected automatically, and turning fiche off puts its settings back.'
  Write-Host '  To remove it: Settings > Apps > Installed apps > fiche.'
  Write-Host ''
  Write-Host '  Claude Code inside WSL2 is separate. Install it there with:'
  Write-Host '    curl -fsSL https://fiche.ink/install.sh | sh'
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
