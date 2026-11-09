<#
Times a real Windows in-place upgrade of Cadsense, phase by phase.

Each run installs -FromInstaller silently, then runs -ToInstaller the way
electron-updater's quitAndInstall does (`--updated /S`). While NSIS works, the
script samples its temp dir, the install dir, and the updater cache every
-PollMs and splits the upgrade into phases. It then launches the upgraded app
with CADSENSE_HOME pointed at a throwaway folder (real ~/.cadsense data is never
opened) and times the first visible window and the main window.

It does not cover the in-app part before NSIS starts (stopping backends and
closing windows); the desktop trace already records that as
desktop.updates.installDownloadedUpdate.

Run from WSL:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\<repo>\scripts\windows-upgrade-timing.ps1 `
    -FromInstaller C:\path\Cadsense-A-x64.exe -ToInstaller C:\path\Cadsense-B-x64.exe -Runs 3

Warning: every channel shares one app id, so this replaces the Cadsense build
installed for the current user. The last run leaves -ToInstaller installed.
It also deletes %LOCALAPPDATA%\cadsense-updater\installer.exe before each
timed upgrade (NSIS rewrites it during the same run) so its rewrite can be timed.

Output in -OutDir: report.md, report.json, and run-N\ with timeline.csv and the
launched app's logs.
#>
param(
  [Parameter(Mandatory = $true)][string]$FromInstaller,
  [Parameter(Mandatory = $true)][string]$ToInstaller,
  [int]$Runs = 3,
  [string]$OutDir = (Join-Path $env:TEMP ("cadsense-upgrade-timing\report-" + (Get-Date -Format "yyyyMMdd-HHmmss"))),
  [int]$PollMs = 100,
  [int]$LaunchTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

$UpdaterCacheInstaller = Join-Path $env:LOCALAPPDATA "cadsense-updater\installer.exe"

# Reads the current user's Cadsense install from the uninstall registry entry.
function Get-InstallInfo {
  $entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties["DisplayName"] -and $_.DisplayName -like "Cadsense*" } |
    Select-Object -First 1
  if (-not $entry) { throw "No Cadsense install found for the current user." }
  $uninstaller = ([regex]::Match($entry.UninstallString, '^"([^"]+)"')).Groups[1].Value
  $dir = Split-Path $uninstaller -Parent
  $exe = Get-ChildItem $dir -Filter *.exe |
    Where-Object { $_.Name -notlike "Uninstall*" -and $_.Name -ne "elevate.exe" } |
    Select-Object -First 1
  [pscustomobject]@{
    Version         = $entry.DisplayVersion
    Dir             = $dir
    Exe             = $exe.FullName
    UninstallerName = Split-Path $uninstaller -Leaf
  }
}

function Get-ProcessesUnder([string]$Dir) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
}

function Stop-InstalledApp([string]$Dir) {
  for ($i = 0; $i -lt 50; $i++) {
    # PowerShell unrolls returned arrays (empty becomes $null), so re-wrap.
    $procs = @(Get-ProcessesUnder $Dir)
    if ($procs.Count -eq 0) { return }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200
  }
  throw "Processes under $Dir did not exit."
}

# Total bytes under a directory, or -1 when it does not exist.
function Get-DirBytes([string]$Path) {
  if (-not $Path -or -not [IO.Directory]::Exists($Path)) { return [long]-1 }
  $total = [long]0
  try {
    foreach ($file in [IO.Directory]::EnumerateFiles($Path, "*", [IO.SearchOption]::AllDirectories)) {
      try { $total += (New-Object IO.FileInfo $file).Length } catch {}
    }
  } catch {}
  return $total
}

# Total bytes of files matching a pattern in one directory, or -1 when none exist.
function Get-FilesBytes([string]$Dir, [string]$Pattern) {
  if (-not $Dir -or -not [IO.Directory]::Exists($Dir)) { return [long]-1 }
  $files = @(Get-ChildItem $Dir -Filter $Pattern -File -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return [long]-1 }
  return [long](($files | Measure-Object Length -Sum).Sum)
}

function Find-Index($Samples, [int]$Start, [scriptblock]$Predicate) {
  if ($Start -lt 0) { return -1 }
  for ($i = $Start; $i -lt $Samples.Count; $i++) {
    if (& $Predicate $Samples[$i]) { return $i }
  }
  return -1
}

function Get-Span($Samples, [int]$From, [int]$To) {
  if ($From -lt 0 -or $To -lt 0) { return $null }
  return [long]($Samples[$To].ms - $Samples[$From].ms)
}

# Runs the upgrade installer and splits its wall time into NSIS phases.
# Order (electron-builder 26 one-click template): app-running check, old
# uninstaller, unpack embedded app-*.7z, 7z extract to temp, copy into the
# install dir, copy installer.exe into the updater cache, registry/shortcuts.
function Measure-Upgrade([string]$Installer, [pscustomobject]$Install, [string]$RunDir) {
  $before = @{}
  Get-ChildItem $env:TEMP -Directory -Filter "ns*.tmp" -ErrorAction SilentlyContinue |
    ForEach-Object { $before[$_.FullName] = $true }
  if (Test-Path $UpdaterCacheInstaller) { Remove-Item $UpdaterCacheInstaller -Force }

  $samples = New-Object System.Collections.Generic.List[object]
  $pluginsDir = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $Installer -ArgumentList "--updated", "/S" -PassThru
  $null = $proc.Handle # cache the handle so ExitCode is readable after exit

  while ($true) {
    $exited = $proc.HasExited
    if (-not $pluginsDir) {
      $pluginsDir = Get-ChildItem $env:TEMP -Directory -Filter "ns*.tmp" -ErrorAction SilentlyContinue |
        Where-Object { -not $before.ContainsKey($_.FullName) } |
        Where-Object {
          (Test-Path (Join-Path $_.FullName "old-uninstaller.exe")) -or
          (Test-Path (Join-Path $_.FullName "7z-out")) -or
          @(Get-ChildItem $_.FullName -Filter "app-*.7z" -ErrorAction SilentlyContinue).Count -gt 0
        } |
        Select-Object -First 1 -ExpandProperty FullName
    }
    $samples.Add([pscustomobject]@{
        ms                 = $sw.ElapsedMilliseconds
        uninstallerRunning = [bool](Get-Process -Name "old-uninstaller" -ErrorAction SilentlyContinue)
        packageBytes       = (Get-FilesBytes $pluginsDir "app-*.7z")
        extractBytes       = $(if ($pluginsDir) { Get-DirBytes (Join-Path $pluginsDir "7z-out") } else { [long]-1 })
        installBytes       = (Get-DirBytes $Install.Dir)
        installerCopyBytes = $(if ([IO.File]::Exists($UpdaterCacheInstaller)) { (New-Object IO.FileInfo $UpdaterCacheInstaller).Length } else { [long]-1 })
        uninstallerWritten = [IO.File]::Exists((Join-Path $Install.Dir $Install.UninstallerName))
      })
    if ($exited) { break }
    Start-Sleep -Milliseconds $PollMs
  }
  $samples | Export-Csv -NoTypeInformation -Path (Join-Path $RunDir "timeline.csv")

  $last = $samples.Count - 1
  $iUninstallStart = Find-Index $samples 0 { param($s) $s.uninstallerRunning }
  $iUninstallEnd = Find-Index $samples ($iUninstallStart + 1) { param($s) -not $s.uninstallerRunning }
  $iEmptied = Find-Index $samples 0 { param($s) $s.installBytes -le 0 }
  $iPackage = Find-Index $samples 0 { param($s) $s.packageBytes -gt 0 }
  $iExtract = Find-Index $samples 0 { param($s) $s.extractBytes -gt 0 }
  $iCopy = Find-Index $samples ([Math]::Max($iEmptied, $iUninstallEnd)) { param($s) $s.installBytes -gt 0 }
  $iSelfCopy = Find-Index $samples ([Math]::Max($iCopy, 0)) { param($s) $s.installerCopyBytes -ge 0 }
  $iUninstallerWritten = Find-Index $samples ([Math]::Max($iCopy, 0)) { param($s) $s.uninstallerWritten }

  [pscustomobject]@{
    exitCode                  = $proc.ExitCode
    samples                   = $samples.Count
    totalMs                   = [long]$samples[$last].ms
    appCheckMs                = $(if ($iUninstallStart -ge 0) { [long]$samples[$iUninstallStart].ms } else { $null })
    oldUninstallerMs          = Get-Span $samples $iUninstallStart $iUninstallEnd
    unpackEmbeddedPackageMs   = Get-Span $samples $iUninstallEnd $iExtract
    extractToTempMs           = Get-Span $samples $iExtract $iCopy
    copyToInstallDirMs        = Get-Span $samples $iCopy $iSelfCopy
    copyInstallerToCacheMs    = Get-Span $samples $iSelfCopy $iUninstallerWritten
    registryShortcutsExitMs   = Get-Span $samples $iUninstallerWritten $last
    packageSeenMs             = $(if ($iPackage -ge 0) { [long]$samples[$iPackage].ms } else { $null })
    extractedBytes            = [long](($samples | Measure-Object extractBytes -Maximum).Maximum)
    installedBytes            = [long]$samples[$last].installBytes
  }
}

# Reads span durations and event times from the launched app's desktop trace.
function Read-StartupTrace([string]$TracePath, [long]$LaunchUnixMs) {
  $result = [ordered]@{
    connectingSplashMs = $null
    backendReadyMs     = $null
    mainWindowMs       = $null
    startupSpanMs      = $null
    shellEnvSpanMs     = $null
  }
  if (-not (Test-Path $TracePath)) { return [pscustomobject]$result }
  foreach ($line in Get-Content $TracePath) {
    try { $row = $line | ConvertFrom-Json } catch { continue }
    if (-not $row.PSObject.Properties["name"]) { continue }
    if ($row.name -eq "desktop.startup" -and $null -eq $result.startupSpanMs) { $result.startupSpanMs = [long]$row.durationMs }
    if ($row.name -eq "desktop.shellEnvironment.installIntoProcess" -and $null -eq $result.shellEnvSpanMs) { $result.shellEnvSpanMs = [long]$row.durationMs }
    if (-not $row.PSObject.Properties["events"]) { continue }
    foreach ($traceEvent in @($row.events)) {
      $atMs = [long]([decimal]$traceEvent.timeUnixNano / 1000000) - $LaunchUnixMs
      switch ($traceEvent.name) {
        "connecting splash shown" { if ($null -eq $result.connectingSplashMs) { $result.connectingSplashMs = $atMs } }
        "backend ready" { if ($null -eq $result.backendReadyMs) { $result.backendReadyMs = $atMs } }
        "main window created" { if ($null -eq $result.mainWindowMs) { $result.mainWindowMs = $atMs } }
      }
    }
  }
  return [pscustomobject]$result
}

# Launches the installed app against a throwaway CADSENSE_HOME and times the
# first visible window (splash or main) and the trace's main-window event.
function Measure-Launch([pscustomobject]$Install, [string]$RunDir) {
  $appHome = Join-Path $RunDir "home"
  New-Item -ItemType Directory -Force $appHome | Out-Null
  $tracePath = Join-Path $appHome "userdata\logs\desktop.trace.ndjson"

  $env:CADSENSE_HOME = $appHome
  $launchUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { $null = Start-Process -FilePath $Install.Exe -PassThru } finally { Remove-Item Env:CADSENSE_HOME }

  $firstWindowMs = $null
  $traceHasMain = $false
  while ($sw.Elapsed.TotalSeconds -lt $LaunchTimeoutSeconds) {
    if ($null -eq $firstWindowMs) {
      $visible = Get-ProcessesUnder $Install.Dir | Where-Object { $_.MainWindowHandle -ne 0 }
      if ($visible) { $firstWindowMs = [long]$sw.ElapsedMilliseconds }
    }
    if (-not $traceHasMain -and (Test-Path $tracePath)) {
      $traceHasMain = Select-String -Path $tracePath -SimpleMatch '"main window created"' -Quiet
    }
    if ($null -ne $firstWindowMs -and $traceHasMain) { break }
    Start-Sleep -Milliseconds 100
  }
  # Give the trace writer one batch window to flush the startup spans.
  Start-Sleep -Seconds 2
  $trace = Read-StartupTrace $tracePath $launchUnixMs
  Stop-InstalledApp $Install.Dir

  [pscustomobject]@{
    firstWindowMs      = $firstWindowMs
    connectingSplashMs = $trace.connectingSplashMs
    backendReadyMs     = $trace.backendReadyMs
    mainWindowMs       = $trace.mainWindowMs
    startupSpanMs      = $trace.startupSpanMs
    shellEnvSpanMs     = $trace.shellEnvSpanMs
    timedOut           = -not $traceHasMain
  }
}

function Get-Median($Values) {
  $sorted = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
  if ($sorted.Count -eq 0) { return $null }
  $mid = [Math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 1) { return [long]$sorted[$mid] }
  return [long](($sorted[$mid - 1] + $sorted[$mid]) / 2)
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$fromName = Split-Path $FromInstaller -Leaf
$toName = Split-Path $ToInstaller -Leaf
$results = @()

for ($run = 1; $run -le $Runs; $run++) {
  $runDir = Join-Path $OutDir "run-$run"
  New-Item -ItemType Directory -Force $runDir | Out-Null

  Write-Host "run ${run}: installing $fromName"
  if ((Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties["DisplayName"] -and $_.DisplayName -like "Cadsense*" })) {
    Stop-InstalledApp (Get-InstallInfo).Dir
  }
  $setup = Start-Process -FilePath $FromInstaller -ArgumentList "/S" -PassThru -Wait
  if ($setup.ExitCode -ne 0) { throw "run ${run}: $fromName exited with $($setup.ExitCode)" }
  $install = Get-InstallInfo
  Stop-InstalledApp $install.Dir
  $fromVersion = $install.Version

  Write-Host "run ${run}: upgrading $fromVersion with $toName"
  $upgrade = Measure-Upgrade $ToInstaller $install $runDir
  # A failed upgrade leaves the old install in place and would time as "fast".
  if ($upgrade.exitCode -ne 0) { throw "run ${run}: $toName exited with $($upgrade.exitCode)" }
  $install = Get-InstallInfo
  Write-Host ("run ${run}: upgrade took {0} ms, launching {1}" -f $upgrade.totalMs, $install.Version)
  $launch = Measure-Launch $install $runDir

  $results += [pscustomobject]@{
    run         = $run
    fromVersion = $fromVersion
    toVersion   = $install.Version
    setupExit   = $setup.ExitCode
    upgrade     = $upgrade
    launch      = $launch
  }
}

$machine = [pscustomobject]@{
  computer = $env:COMPUTERNAME
  os       = (Get-CimInstance Win32_OperatingSystem).Caption
  cpu      = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
  disk     = $(try { Get-PhysicalDisk | Select-Object -First 1 | ForEach-Object { "$($_.FriendlyName) ($($_.MediaType))" } } catch { "unknown" })
  defender = $(try { (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { "unknown" })
}
$report = [pscustomobject]@{
  generatedAt = (Get-Date).ToString("o")
  from        = $fromName
  to          = $toName
  pollMs      = $PollMs
  machine     = $machine
  runs        = $results
}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $OutDir "report.json")

$rows = @(
  @("Upgrade total (installer start to exit)", "upgrade", "totalMs"),
  @("  App-running check", "upgrade", "appCheckMs"),
  @("  Old uninstaller (move + delete old files)", "upgrade", "oldUninstallerMs"),
  @("  Unpack embedded app-*.7z to temp", "upgrade", "unpackEmbeddedPackageMs"),
  @("  7z extract to temp", "upgrade", "extractToTempMs"),
  @("  Copy into install dir", "upgrade", "copyToInstallDirMs"),
  @("  Copy installer.exe to updater cache", "upgrade", "copyInstallerToCacheMs"),
  @("  Registry, shortcuts, exit", "upgrade", "registryShortcutsExitMs"),
  @("Launch to first visible window", "launch", "firstWindowMs"),
  @("Launch to connecting splash (trace)", "launch", "connectingSplashMs"),
  @("Launch to backend ready (trace)", "launch", "backendReadyMs"),
  @("Launch to main window (trace)", "launch", "mainWindowMs"),
  @("desktop.startup span", "launch", "startupSpanMs"),
  @("Shell env read span", "launch", "shellEnvSpanMs")
)
$header = "| Metric (ms) | " + (($results | ForEach-Object { "Run $($_.run)" }) -join " | ") + " | Median |"
$divider = "|---|" + (($results | ForEach-Object { "---:" }) -join "|") + "|---:|"
$lines = @(
  "# Windows upgrade timing",
  "",
  "$fromName to $toName, $Runs runs, polled every $PollMs ms.",
  "",
  "Machine: $($machine.computer), $($machine.os), $($machine.cpu), $($machine.disk), Defender real-time: $($machine.defender).",
  "",
  $header,
  $divider
)
foreach ($row in $rows) {
  $values = @($results | ForEach-Object { $_.($row[1]).($row[2]) })
  $cells = ($values | ForEach-Object { if ($null -eq $_) { "n/a" } else { "$_" } }) -join " | "
  $median = Get-Median $values
  $lines += "| $($row[0]) | $cells | $(if ($null -eq $median) { 'n/a' } else { $median }) |"
}
$lines += ""
$lines += "Extracted payload: $([Math]::Round(($results[0].upgrade.extractedBytes) / 1MB)) MB. Installed: $([Math]::Round(($results[0].upgrade.installedBytes) / 1MB)) MB."
$lines += "Launch numbers use a fresh CADSENSE_HOME, so backend readiness includes first-run database setup."
$lines | Set-Content -Encoding UTF8 (Join-Path $OutDir "report.md")

Write-Host "report: $(Join-Path $OutDir 'report.md')"
