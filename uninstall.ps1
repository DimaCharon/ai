# ============================================================
#  Charon Code - FULL REMOVAL (PowerShell)
#  Run:  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#  Removes: program, data (accounts/keys/cookie/chats),
#  shortcuts, registry entries and autostart.
# ============================================================
$ErrorActionPreference = "Continue"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  CHARON CODE - FULL REMOVAL" -ForegroundColor Cyan
Write-Host "============================================================"

# 1. Processes
Get-Process "Charon Code" -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "[1/5] Processes stopped."

# 2. Install folder (NSIS default: %LOCALAPPDATA%\Programs\Charon Code)
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Charon Code"
if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
    Write-Host "[2/5] Removed: $installDir"
} else {
    Write-Host "[2/5] Not found. If you installed to another folder, remove it manually."
}

# 3. DATA: accounts, API keys, Arena cookie, chats, settings
$dataDir = Join-Path $env:APPDATA "Charon Code"
if (Test-Path $dataDir) {
    Remove-Item $dataDir -Recurse -Force
    Write-Host "[3/5] Removed: $dataDir" -ForegroundColor Yellow
} else {
    Write-Host "[3/5] Not found."
}

# 4. Shortcuts
$shortcutDirs = @(
    [Environment]::GetFolderPath("Programs"),
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("CommonDesktopDirectory")
)
foreach ($dir in $shortcutDirs) {
    $lnk = Join-Path $dir "Charon Code.lnk"
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force
        Write-Host "Shortcut removed: $lnk"
    }
}
$smFolder = Join-Path ([Environment]::GetFolderPath("Programs")) "Charon Code"
if (Test-Path $smFolder) { Remove-Item $smFolder -Recurse -Force; Write-Host "Start Menu folder removed: $smFolder" }
Write-Host "[4/5] Shortcuts checked."

# 5. Registry
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Charon Code" -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Charon Code" -ErrorAction SilentlyContinue
Write-Host "[5/5] Registry cleaned."

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  DONE. Charon Code is fully removed from this PC." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Read-Host "Press Enter to exit"
