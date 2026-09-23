@echo off
chcp 65001 >nul
title Полное удаление Charon Code
echo ============================================================
echo   CHARON CODE - ПОЛНОЕ УДАЛЕНИЕ
echo   Стирает: программу, данные, аккаунты, ключи, автостарт
echo ============================================================
echo.

REM --- 1. Завершаем процессы ---
taskkill /f /im "Charon Code.exe" >nul 2>&1
taskkill /f /im "electron.exe" >nul 2>&1
echo [1/5] Процесс завершён.

REM --- 2. Каталог установки (NSIS / portable) ---
if exist "%LOCALAPPDATA%\Programs\Charon Code\" (
  rmdir /s /q "%LOCALAPPDATA%\Programs\Charon Code"
  echo [2/5] Каталог установки удалён: %LOCALAPPDATA%\Programs\Charon Code
) else (
  echo [2/5] Каталог установки не найден (возможно, установлен в другое место).
)

REM --- 3. ДАННЫЕ: аккаунты, ключи API, кука, чаты, настройки ---
if exist "%APPDATA%\Charon Code" (
  rmdir /s /q "%APPDATA%\Charon Code"
  echo [3/5] Данные удалены: %APPDATA%\Charon Code
) else (
  echo [3/5] Данные не найдены.
)

REM --- 4. Ярлыки (Start Menu, рабочий стол) ---
powershell -NoProfile -Command ^
  "$paths = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory')); " ^
  "foreach ($p in $paths) { $l = Join-Path $p 'Charon Code.lnk'; if (Test-Path $l) { Remove-Item $l -Force; Write-Host ('Ярлык удалён: ' + $l) } }"
echo [4/5] Ярлыки проверены.

REM --- 5. Реестр: запись о программе + автостарт (если был включён) ---
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Charon Code" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Charon Code" /f >nul 2>&1
echo [5/5] Реестр очищен.

echo.
echo ============================================================
echo   ГОТОВО. Charon Code полностью удалён с компьютера.
echo ============================================================
pause
