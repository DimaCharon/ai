# ============================================================
#  Charon Code - FULL REMOVAL (PowerShell, v2)
#  Run:  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#  Finds the install folder via the registry (works with ANY
#  install directory, e.g. D:\...\Charon Code), then removes:
#  program, app data (accounts/keys/cookie/chats/cache),
#  shortcuts and registry entries.
# ============================================================
$ErrorActionPreference = "SilentlyContinue"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  CHARON CODE - FULL REMOVAL (v2)" -ForegroundColor Cyan
Write-Host "============================================================"

# 1. Processes
Get-Process | Where-Object { $_.ProcessName -like "Charon Code*" } | Stop-Process -Force
Start-Sleep -Seconds 1
Write-Host "[1/5] Processes stopped."

# 2. Find the install folder via the Uninstall registry keys
$keys = @()
foreach ($hive in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
                    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall")) {
    Get-ChildItem $hive | ForEach-Object {
        if ($_.GetValue("DisplayName") -like "Charon Code*") { $keys += $_.PSPath }
    }
}
$dirs = @()
foreach ($k in $keys) {
    $il = (Get-Item $k).GetValue("InstallLocation")
    if ($il -and (Test-Path $il)) { $dirs += $il }
}
if ($dirs.Count -eq 0) {
    $d0 = Join-Path $env:LOCALAPPDATA "Programs\Charon Code"
    if (Test-Path $d0) { $dirs += $d0 }
}
if ($dirs.Count -eq 0) {
    Write-Host "[2/5] Install folder: not found (already removed?)"
} else {
    foreach ($d in $dirs) {
        Remove-Item $d -Recurse -Force
        Write-Host "[2/5] Removed install: $d"
    }
}

# 3. App data on C: (accounts, API keys, Arena cookie, chats, settings, cache)
$data = @()
foreach ($p in @((Join-Path $env:APPDATA "Charon Code"),
                 (Join-Path $env:LOCALAPPDATA "Charon Code"),
                 (Join-Path $env:LOCALAPPDATA "charon-code"))) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; $data += $p }
}
if ($data.Count -eq 0) {
    Write-Host "[3/5] App data on C:: not found"
} else {
    foreach ($p in $data) { Write-Host "[3/5] Removed data: $p" -ForegroundColor Yellow }
}

# 4. Shortcuts (Start Menu user + common, Desktop user + public)
$sm  = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$smc = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"
foreach ($base in @($sm, $smc)) {
    foreach ($t in @((Join-Path $base "Charon Code"), (Join-Path $base "Charon Code.lnk"))) {
        if (Test-Path $t) { Remove-Item $t -Recurse -Force; Write-Host "[4/5] Removed: $t" }
    }
}
foreach ($dd in @((Join-Path $env:USERPROFILE "Desktop"), (Join-Path $env:PUBLIC "Desktop"))) {
    $l = Join-Path $dd "Charon Code.lnk"
    if (Test-Path $l) { Remove-Item $l -Force; Write-Host "[4/5] Removed: $l" }
}

# 5. Registry (uninstall entry + autostart)
foreach ($k in $keys) {
    Remove-Item $k -Recurse
    Write-Host "[5/5] Removed registry key: $k"
}
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Charon Code"
Write-Host "[5/5] Registry cleaned."

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  DONE. Charon Code is fully removed from this PC." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Read-Host "Press Enter to exit"
