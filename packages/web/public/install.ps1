# Cache-bust: 2026-08-03T00-00-00Z
# nikcli installer for Windows (PowerShell 5.1+ / pwsh 7+)
#
#   irm https://nikcli-ai.dev/install.ps1 | iex
#
# Configuration (env vars, because `iex` cannot forward parameters):
#   $env:NIKCLI_VERSION      install a specific version instead of the latest
#   $env:NIKCLI_INSTALL_DIR  install location (default: $HOME\.nikcli\bin)
#   $env:NIKCLI_NO_PATH      set to 1 to skip modifying the user PATH

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$App = "nikcli"
$AssetPrefix = "nikcli-ai"
$Repo = "nikcli/nikcli"

# Windows PowerShell 5.1 still defaults to TLS 1.0, which GitHub refuses.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # pwsh 7 negotiates TLS on its own and does not expose this knob.
}

function Write-Rail([string]$Glyph, [string]$Text, [string]$Color) {
  Write-Host "$Glyph  " -ForegroundColor $Color -NoNewline
  Write-Host $Text
}
function Step([string]$Text) { Write-Rail "*" $Text "Cyan" }
function Warn([string]$Text) { Write-Rail "!" $Text "Yellow" }
function Fail([string]$Text) { Write-Rail "x" $Text "Red"; exit 1 }

Write-Host ""
Write-Host "  nikcli installer" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

function Get-Arch {
  # PROCESSOR_ARCHITECTURE reports the *process* architecture, so an x86 host
  # process on ARM64 would lie; ARCHITEW6432 and RuntimeInformation do not.
  $native = $env:PROCESSOR_ARCHITEW6432
  if (-not $native) { $native = $env:PROCESSOR_ARCHITECTURE }
  try {
    $os = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if ($os) { $native = $os }
  } catch {
    # RuntimeInformation is unavailable on Windows PowerShell 5.1 in some hosts.
  }
  switch -Regex ($native) {
    "^(ARM64|Arm64)$" { return "arm64" }
    "^(AMD64|X64|x86_64)$" { return "x64" }
    default { return $null }
  }
}

function Test-Avx2 {
  # PF_AVX2_INSTRUCTIONS_AVAILABLE == 40. Getting this wrong is not a slowdown:
  # an AVX2 build on a CPU without AVX2 dies with an illegal instruction.
  try {
    $kernel = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);' -Name "NikcliKernel32" -Namespace "Win32" -PassThru
    return [bool]$kernel::IsProcessorFeaturePresent(40)
  } catch {
    return $false
  }
}

$arch = Get-Arch
if (-not $arch) { Fail "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }

# Bun 1.4 emits one x64 build that is itself baseline (no AVX2 required), so
# releases from 1.300.0 on ship no `-baseline` asset at all; earlier releases do.
# When the CPU needs baseline we try the baseline asset first and fall back to
# the plain target: on an old release the baseline asset exists and wins, and on
# a new one the plain asset it falls back to runs everywhere. Never the reverse:
# an AVX2 build on a CPU without AVX2 dies with an illegal instruction.
$targets = @("windows-$arch")
if ($arch -eq "x64" -and -not (Test-Avx2)) {
  $targets = @("windows-$arch-baseline", "windows-$arch")
  Step "Detected: windows ($arch, no AVX2 - preferring baseline build)"
} else {
  Step "Detected: windows ($arch)"
}

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------

$requested = $env:NIKCLI_VERSION
if ($requested) {
  $version = $requested.TrimStart("v")
  $tag = "v$version"
  Step "Target version: $version"
} else {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "nikcli-install" } -UseBasicParsing
    $version = ([string]$release.tag_name).TrimStart("v")
  } catch {
    Fail "Failed to fetch version information: $($_.Exception.Message)"
  }
  if (-not $version) { Fail "Failed to resolve the latest nikcli version" }
  $tag = "v$version"
  Step "Latest version: $version"
}

# GitHub first: nikcli-ai.dev does not proxy release assets today, and the bash
# installer keeps it only as a legacy primary.
$urls = @()
foreach ($candidate in $targets) {
  $candidateFile = "$AssetPrefix-$candidate.zip"
  $urls += "https://github.com/$Repo/releases/download/$tag/$candidateFile"
  $urls += "https://nikcli-ai.dev/releases/download/$tag/$candidateFile"
}

# ---------------------------------------------------------------------------
# Install location
# ---------------------------------------------------------------------------

$installDir = $env:NIKCLI_INSTALL_DIR
if (-not $installDir) { $installDir = Join-Path $HOME ".nikcli\bin" }
$targetExe = Join-Path $installDir "$App.exe"
$deferredInstall = $false

# Same path the bash installer uses under Git Bash, so `nikcli upgrade` keeps
# detecting the standalone install method on both.
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# A locked upgrade stages the new binary next to the old one (see below) and a
# detached process swaps it in later. If that process never got to run, the
# staged copy would sit here forever, so sweep the ones nothing can be waiting
# on anymore. The window is generous: the swap waits for the nikcli process to
# exit, and a TUI session can stay open for a long time.
Get-ChildItem -Path $installDir -Filter "$App.update.*.exe" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddDays(-7) } |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# The swap renames the outgoing binary aside before replacing it (a running exe
# can be renamed but not overwritten). Those leftovers are dead weight -
# hundreds of MB each - as soon as the process holding them exits, so drop the
# ones we can now delete.
Get-ChildItem -Path $installDir -Filter "$App.exe.old.*" -File -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# Apply any staged update left over from a previous upgrade that could not
# swap in place. The staged binary is left beside the running one when
# `nikcli upgrade` calls us; the detached helper that should swap it in runs
# after this script exits, so if the user relaunches the installer (or another
# `nikcli upgrade`) before the helper has had a chance to run, we apply the
# staged binary here instead of re-downloading it.
#
# The catch is timing: we must not overwrite a nikcli.exe that is still
# running, because Windows locks the image against writes. The staged binary
# is matched to a specific upgrade PID via $env:NIKCLI_UPGRADE_PID that the
# previous installer ran with. If that PID is set and the process is still
# alive, we leave the staged file alone (the helper will do the swap). If it
# is not set, or the process is gone, we apply it now.
$stagedPending = Get-ChildItem -Path $installDir -Filter "$App.update.*.exe" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($stagedPending) {
  $staleByPid = $true
  if ($env:NIKCLI_UPGRADE_PID) {
    $staleUpgrader = 0
    [void][int]::TryParse($env:NIKCLI_UPGRADE_PID, [ref]$staleUpgrader)
    if ($staleUpgrader -gt 0) {
      $staleByPid = $false
      try {
        $running = Get-Process -Id $staleUpgrader -ErrorAction Stop
        if ($running -and $running.Path -eq $targetExe) {
          Step "Previous upgrade still pending (PID $staleUpgrader is running); will retry the swap"
        } else {
          $staleByPid = $true
        }
      } catch {
        # The PID was set but the process is gone: safe to apply.
        $staleByPid = $true
      }
    }
  }
  if ($staleByPid) {
    if (Test-Path $targetExe) {
      try {
        Move-Item -LiteralPath $targetExe -Destination ($targetExe + ".old." + [System.Guid]::NewGuid().ToString("N")) -Force -ErrorAction Stop
      } catch {
        # The old binary is still locked: leave the staged file in place and
        # let the next run (or the helper) try again. This is the same shape
        # the live-install path falls back to.
        Warn "Could not apply staged update: $($_.Exception.Message)"
      }
    }
    try {
      Move-Item -LiteralPath $stagedPending.FullName -Destination $targetExe -Force -ErrorAction Stop
      Step "Applied staged update from $($stagedPending.Name)"
    } catch {
      Warn "Could not apply staged update: $($_.Exception.Message)"
    }
  }
}

# A deferred swap runs after this script is gone, so its only way to report a
# failure is this log. Surface it once, then clear it.
$updateLog = Join-Path $installDir "$App.update.log"
if (Test-Path $updateLog) {
  $previousFailure = (Get-Content $updateLog -Raw -ErrorAction SilentlyContinue)
  if ($previousFailure) { Warn "Previous deferred update failed: $($previousFailure.Trim())" }
  Remove-Item $updateLog -Force -ErrorAction SilentlyContinue
}

if (Test-Path $targetExe) {
  try {
    $installed = (& $targetExe --version 2>$null | Select-Object -First 1)
    if ($installed) { $installed = $installed.Trim() }
    if ($installed -eq $version) {
      Step "Version $version already installed"
      Write-Host ""
      exit 0
    }
    if ($installed) { Step "Currently installed: $installed -> $version" }
  } catch {
    # An unreadable or half-written binary just gets replaced below.
  }
}

# ---------------------------------------------------------------------------
# Download + extract
# ---------------------------------------------------------------------------

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("nikcli_install_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $downloaded = $false
  foreach ($url in $urls) {
    $filename = Split-Path -Path $url -Leaf
    $archive = Join-Path $tmp $filename
    try {
      Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
      if ((Test-Path $archive) -and ((Get-Item $archive).Length -gt 0)) {
        $downloaded = $true
        break
      }
    } catch {
      Remove-Item $archive -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $downloaded) { Fail "Failed to download nikcli for $($targets -join ' or ')" }
  Step "Downloaded $filename"

  $extract = Join-Path $tmp "extract"
  try {
    Expand-Archive -Path $archive -DestinationPath $extract -Force
  } catch {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $extract)
  }

  # Archive layout is <triplet>/bin/nikcli.exe today; older releases were flat.
  $found = Get-ChildItem -Path $extract -Filter "$App.exe" -Recurse -File | Select-Object -First 1
  if (-not $found) { Fail "$App.exe not found inside $filename" }

  try {
    Copy-Item -Path $found.FullName -Destination $targetExe -Force
  } catch {
    $upgradePid = 0
    if ($env:NIKCLI_UPGRADE_PID) {
      [void][int]::TryParse($env:NIKCLI_UPGRADE_PID, [ref]$upgradePid)
    }
    if ($upgradePid -le 0) {
      Fail "Could not write $targetExe - close any running nikcli process and retry. ($($_.Exception.Message))"
    }

    # Windows locks a running executable. Stage the replacement beside it and
    # let a detached PowerShell process swap it in after `nikcli upgrade` exits.
    $pendingExe = Join-Path $installDir ("$App.update." + [System.Guid]::NewGuid().ToString("N") + ".exe")
    try {
      Copy-Item -Path $found.FullName -Destination $pendingExe -Force
      $quotedPending = $pendingExe.Replace("'", "''")
      $quotedTarget = $targetExe.Replace("'", "''")
      $quotedLog = (Join-Path $installDir "$App.update.log").Replace("'", "''")
      $quotedVersion = $version.Replace("'", "''")
      # Two escape hatches the previous version lacked:
      #  - a 2 minute window instead of 10s, because moving a ~160MB binary on
      #    a slow disk (or behind AV) can take longer than that;
      #  - a rename-aside fallback: Windows refuses to overwrite a running exe
      #    but does allow renaming it, so if the user relaunched nikcli in the
      #    meantime we move the old file out of the way instead of giving up.
      # And on failure the staged file is kept, not deleted, so the next
      # installer run can still apply it - with the reason written to a log.
      $helperScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
Wait-Process -Id $upgradePid -ErrorAction SilentlyContinue
`$lastError = ''
for (`$attempt = 0; `$attempt -lt 480; `$attempt++) {
  try {
    Move-Item -LiteralPath '$quotedPending' -Destination '$quotedTarget' -Force -ErrorAction Stop
    # Confirm the swap took effect. The expected version is interpolated
    # into the helper at build time so the probe works on PowerShell 5.1
    # (where `Start-Process -Environment` was not added until 7.x).
    # If the new binary's probe disagrees, the move may have succeeded but
    # the file is corrupted or the wrong target was downloaded. Surface a
    # mismatch so the next installer run warns about it.
    `$installed = (& '$quotedTarget' --version 2>`$null | Select-Object -First 1)
    if (`$installed) { `$installed = `$installed.Trim() }
    if (`$installed -and (`$installed -replace '^v','') -ne ('$quotedVersion' -replace '^v','')) {
      Set-Content -LiteralPath '$quotedLog' -Value ("Swapped to $quotedTarget but probe reports '" + `$installed + "' (expected '$quotedVersion')") -ErrorAction SilentlyContinue
    }
    exit 0
  } catch {
    `$lastError = `$_.Exception.Message
    Start-Sleep -Milliseconds 250
  }
}
# Still locked: rename the running binary aside and slot the new one in. The
# leftover is swept by the next installer run.
try {
  `$aside = '$quotedTarget' + '.old.' + [System.Guid]::NewGuid().ToString('N')
  Move-Item -LiteralPath '$quotedTarget' -Destination `$aside -Force -ErrorAction Stop
  Move-Item -LiteralPath '$quotedPending' -Destination '$quotedTarget' -Force -ErrorAction Stop
  `$installed = (& '$quotedTarget' --version 2>`$null | Select-Object -First 1)
  if (`$installed) { `$installed = `$installed.Trim() }
  if (`$installed -and (`$installed -replace '^v','') -ne ('$quotedVersion' -replace '^v','')) {
    Set-Content -LiteralPath '$quotedLog' -Value ("Swapped to $quotedTarget but probe reports '" + `$installed + "' (expected '$quotedVersion')") -ErrorAction SilentlyContinue
  }
  exit 0
} catch {
  `$lastError = `$_.Exception.Message
}
Set-Content -LiteralPath '$quotedLog' -Value ("Could not replace " + '$quotedTarget' + ": " + `$lastError + " (staged update kept at " + '$quotedPending' + ")") -ErrorAction SilentlyContinue
exit 1
"@
      $encodedHelper = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helperScript))
      # Re-use the host running this script (powershell.exe or pwsh.exe) so the
      # swap keeps working on machines where only one of them is on PATH.
      $powershellExe = $null
      try { $powershellExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
      if (-not $powershellExe -or ($powershellExe -notmatch "(powershell|pwsh)\.exe$")) {
        $powershellExe = "powershell.exe"
      }
      Start-Process -FilePath $powershellExe -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        $encodedHelper
      ) | Out-Null
      $deferredInstall = $true
      Step "Update staged; nikcli.exe will be replaced when this command exits"
    } catch {
      Remove-Item $pendingExe -Force -ErrorAction SilentlyContinue
      Fail "Could not stage the update for $targetExe. ($($_.Exception.Message))"
    }
  }
  if (-not $deferredInstall) { Step "Installed to $targetExe" }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# PATH (user scope only - never needs elevation)
# ---------------------------------------------------------------------------

if ($env:NIKCLI_NO_PATH -ne "1") {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $current) { $current = "" }
  $parts = $current -split ";" | Where-Object { $_ -ne "" }
  if ($parts -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $installDir) -join ";"), "User")
    Step "Added $installDir to your user PATH"
    Warn "Open a new terminal for the PATH change to take effect"
  } else {
    Step "$installDir already on PATH"
  }
  # Make it usable immediately in this session too.
  if (($env:Path -split ";") -notcontains $installDir) {
    $env:Path = "$env:Path;$installDir"
  }
}

Write-Host ""
Write-Host "  nikcli $version installed" -ForegroundColor Green
Write-Host ""
Write-Host "   Next steps"
Write-Host "   cd <project>          # open your project"
Write-Host "   nikcli                # start nikcli"
Write-Host ""
Write-Host "   Docs: https://nikcli-ai.dev/docs"
Write-Host ""
