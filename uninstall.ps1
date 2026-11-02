# ============================================================
#  Charon Code - TOTAL UNINSTALLER v3 (v1.0.8)
#  Finds and removes EVERYTHING the app left:
#   - program from the install dir (ANY drive/folder, via registry)
#   - ALL data: AppData Roaming/Local (deep scan for "charon")
#   - Program Files / ProgramData / Desktop / Downloads
#   - sweep of every fixed drive root (depth 2) for "charon*"
#   - temp leftovers (plugin installs, electron cache)
#  Registry uninstall key is removed too.
#  ASCII + CRLF (RU Windows safe).
# ============================================================
$ErrorActionPreference = "Continue"
$Title = "Charon Code - Total Uninstall v3"

function Say($t) { Write-Host $t }
function SayW($t) { Write-Host $t -ForegroundColor Yellow }
function SayR($t) { Write-Host $t -ForegroundColor Red }

Say "======================================================"
Say $Title
Say "======================================================"
Say ""

# ---------- 0. kill running processes ----------
Get-Process | Where-Object { $_.Name -like "Charon Code*" -or $_.Name -like "charon*" } | ForEach-Object {
  SayW "Stopping process: $($_.Name) (PID $($_.Id))"
  try { $_ | Stop-Process -Force -ErrorAction Stop } catch { }
}
Start-Sleep -Milliseconds 800

# ---------- self guard: never delete the folder this script runs from ----------
$selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path
function InSelfDir([string]$p) {
  try {
    $f = (Resolve-Path -LiteralPath $p -ErrorAction Stop).Path
    return ($f -eq $selfDir) -or ($f -like "$selfDir\*") -or ($selfDir -like "$f\*")
  } catch { return $false }
}

# ---------- collect candidates ----------
$targets = @()

# a) registry: install location of Charon Code
$regPaths = @(
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$regKeys = @()
foreach ($rp in $regPaths) {
  Get-ItemProperty $rp -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "*Charon Code*" } |
    ForEach-Object { $regKeys += $_.PSPath; if ($_.InstallLocation) { $targets += $_.InstallLocation } }
}

# b) AppData deep scan (names contain "charon")
$scanRoots = @()
if ($env:APPDATA)      { $scanRoots += $env:APPDATA }
if ($env:LOCALAPPDATA) { $scanRoots += $env:LOCALAPPDATA }
if ($env:USERPROFILE)  { $scanRoots += (Join-Path $env:USERPROFILE "Desktop"), (Join-Path $env:USERPROFILE "Downloads") }
foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData)) {
  if ($pf -and (Test-Path $pf)) { $scanRoots += $pf }
}

function AddByName([string]$root, [int]$depth) {
  if (-not $root -or -not (Test-Path $root)) { return }
  try {
    $items = Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue
    foreach ($it in $items) {
      if ($it.Name -like "*charon*" -and ($it.Name -ne "*.tmp")) {
        if (-not (InSelfDir $it.FullName)) { $targets += $it.FullName }
      }
      if ($it.PSIsContainer -and $depth -gt 1) { AddByName $it.FullName ($depth - 1) }
    }
  } catch { }
}

foreach ($r in $scanRoots) {
  if ($r -like "$env:APPDATA*" -or $r -like "$env:LOCALAPPDATA*") { AddByName $r 3 }
  else { AddByName $r 2 }
}

# c) every fixed drive: root + depth-2 sweep for "charon*"
$drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq "Fixed" }
foreach ($d in $drives) {
  $root = $d.RootDirectory.FullName
  SayW "Sweeping drive ${d.Name} (depth 2)..."
  AddByName $root 2
}

# d) temp leftovers
$targets += (Join-Path $env:TEMP "cc-plugin-*")
$targets += (Join-Path $env:TEMP "cc-plugin-ex-*")
try {
  Get-ChildItem -Path $env:TEMP -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "cc-plugin*" } |
    ForEach-Object { $targets += $_.FullName }
} catch { }

# ---------- dedupe + filter ----------
$targets = $targets | Where-Object { $_ } | Sort-Object -Unique |
  Where-Object { (Test-Path $_) -and (-not (InSelfDir $_)) }

# ---------- show + confirm ----------
Say ""
if ($targets.Count -eq 0) {
  Say "Nothing found. Charon Code appears to be already clean on this PC."
} else {
  Say "Found $($targets.Count) item(s) to remove:"
  Say "------------------------------------------------------"
  foreach ($t in $targets) { Say "  $t" }
  Say "------------------------------------------------------"
  Say ""
  Say "This will DELETE all of the above (programs, settings, chats, memory, plugins)."
  $ans = Read-Host "Type YES to delete everything"
  if ($ans -ne "YES") {
    Say "Cancelled. Nothing was deleted."
    exit 0
  }
  $deleted = 0
  foreach ($t in $targets) {
    try {
      Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction Stop
      SayW "Deleted: $t"
      $deleted++
    } catch {
      SayR "Could not delete: $t ($($_.Exception.Message))"
    }
  }
  Say "Deleted $deleted item(s)."
}

# ---------- remove registry uninstall key ----------
foreach ($rk in $regKeys) {
  SayW "Removing registry key: $rk"
  try { Remove-Item -LiteralPath $rk -Recurse -Force -ErrorAction Stop } catch {
    SayR "Registry key left: $rk"
  }
}

Say ""
Say "Done. Charon Code and all its files were removed from this PC."
Say "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
