# ============================================================
#  Charon Code — ПОЛНОЕ УДАЛЕНИЕ (PowerShell)
#  Запуск:  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#  Стирает: программу, данные (аккаунты/ключи/кука/чаты),
#  ярлыки, запись в реестре об установке и автостарт.
# ============================================================

$ErrorActionPreference = "Continue"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  CHARON CODE - ПОЛНОЕ УДАЛЕНИЕ" -ForegroundColor Cyan
Write-Host "============================================================"

# 1. Процессы
Get-Process "Charon Code" -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "[1/5] Процесс завершён."

# 2. Каталог установки (NSIS по умолчанию: %LOCALAPPDATA%\Programs\Charon Code)
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Charon Code"
if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
    Write-Host "[2/5] Каталог установки удалён: $installDir"
} else {
    Write-Host "[2/5] Каталог установки не найден (возможно, другое место установки)."
}

# 3. ДАННЫЕ: аккаунты, ключи API, кука, чаты, настройки
$dataDir = Join-Path $env:APPDATA "Charon Code"
if (Test-Path $dataDir) {
    Remove-Item $dataDir -Recurse -Force
    Write-Host "[3/5] Данные удалены: $dataDir" -ForegroundColor Yellow
} else {
    Write-Host "[3/5] Данные не найдены."
}

# 4. Ярлыки
$shortcutDirs = @(
    [Environment]::GetFolderPath("Programs"),
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("CommonDesktopDirectory")
)
foreach ($dir in $shortcutDirs) {
    $lnk = Join-Path $dir "Charon Code.lnk"
    if (Test-Path $lnk) {
        Remove-Item $lnk -Force
        Write-Host "Ярлык удалён: $lnk"
    }
}
Write-Host "[4/5] Ярлыки проверены."

# 5. Реестр
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Charon Code" -Recurse -ErrorAction SilentlyContinue
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Charon Code" -ErrorAction SilentlyContinue
Write-Host "[5/5] Реестр очищен."

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  ГОТОВО. Charon Code полностью удалён с компьютера." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Read-Host "Нажмите Enter для выхода"
