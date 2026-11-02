======================================================
 Charon Code - Total Uninstaller v3 (all drives, all files)
======================================================

@echo off
setlocal
set "SELF_DIR=%~dp0"
set "PS1=%SELF_DIR%uninstall.ps1"
if not exist "%PS1%" (
  echo uninstall.ps1 not found next to this script.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
