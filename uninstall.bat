@echo off
setlocal
title Charon Code - FULL REMOVAL
echo ============================================================
echo   CHARON CODE - FULL REMOVAL
echo   Removes: program, data, accounts, keys, autostart,
echo   shortcuts and registry entries.
echo ============================================================
echo.

echo [1/5] Killing processes...
taskkill /f /im "Charon Code.exe" >nul 2>&1
taskkill /f /im "electron.exe" >nul 2>&1

echo [2/5] Removing install folder...
if exist "%LOCALAPPDATA%\Programs\Charon Code" (
  rmdir /s /q "%LOCALAPPDATA%\Programs\Charon Code"
  echo     Removed: %LOCALAPPDATA%\Programs\Charon Code
) else (
  echo     Not found. If you installed to another folder, remove it manually.
)

echo [3/5] Removing DATA: accounts, API keys, Arena cookie, chats, settings...
if exist "%APPDATA%\Charon Code" (
  rmdir /s /q "%APPDATA%\Charon Code"
  echo     Removed: %APPDATA%\Charon Code
) else (
  echo     Not found.
)

echo [4/5] Removing shortcuts...
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Charon Code" rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Charon Code"
if exist "%USERPROFILE%\Desktop\Charon Code.lnk" del /q "%USERPROFILE%\Desktop\Charon Code.lnk"
if exist "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Charon Code" rmdir /s /q "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Charon Code"

echo [5/5] Cleaning registry: uninstall entry and autostart...
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Charon Code" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "Charon Code" /f >nul 2>&1

echo.
echo ============================================================
echo   DONE. Charon Code is fully removed from this PC.
echo ============================================================
pause
endlocal
