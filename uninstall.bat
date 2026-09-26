@echo off
setlocal
title Charon Code - FULL REMOVAL
echo ============================================================
echo   CHARON CODE - FULL REMOVAL (v2)
echo   The install folder is found via the Windows registry,
echo   so it works with ANY directory (C:, D:, ..., any name).
echo   Removes: program, app data (C:), shortcuts, registry.
echo ============================================================
echo.

rem --- if this bat sits INSIDE the install folder, move it to
rem --- %TEMP% first, otherwise the folder cannot delete itself
if exist "%~dp0Charon Code*.exe" (
  echo [prep] Uninstaller is inside the install folder - moving it to a temp file...
  copy /y "%~f0" "%TEMP%\cc_uninst_tmp.bat" >nul
  call "%TEMP%\cc_uninst_tmp.bat"
  del /q "%TEMP%\cc_uninst_tmp.bat" >nul 2>&1
  exit /b
)

echo [1/5] Stopping Charon Code processes (app + overlay)...
taskkill /f /im "Charon Code*.exe" >nul 2>&1
timeout /t 1 /nobreak >nul
echo       done.

echo [2/5] Removing program (install folder), data, shortcuts, registry...
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference='SilentlyContinue'; $keys=@(); foreach($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')){ Get-ChildItem $hive | ForEach-Object { $n=$_.GetValue('DisplayName'); if($n -like 'Charon Code*'){ $keys += $_.PSPath } } }; $dirs=@(); foreach($k in $keys){ $il=(Get-Item $k).GetValue('InstallLocation'); if($il -and (Test-Path $il)){ $dirs += $il } }; if($dirs.Count -eq 0){ $d0=Join-Path $env:LOCALAPPDATA 'Programs\Charon Code'; if(Test-Path $d0){ $dirs += $d0 } }; if($dirs.Count -eq 0){ Write-Host '  [2/5] install folder: not found (already removed?)' } else { foreach($d in $dirs){ Remove-Item $d -Recurse -Force; Write-Host ('  [2/5] removed install: '+$d) } }; $data=@(); foreach($p in @((Join-Path $env:APPDATA 'Charon Code'),(Join-Path $env:LOCALAPPDATA 'Charon Code'),(Join-Path $env:LOCALAPPDATA 'charon-code'))){ if(Test-Path $p){ Remove-Item $p -Recurse -Force; $data += $p } }; if($data.Count -eq 0){ Write-Host '  [3/5] app data on C: (accounts/keys/cookie/chats/cache): not found' } else { foreach($p in $data){ Write-Host ('  [3/5] removed data: '+$p) } }; $sm=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'; $smc=Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'; foreach($base in @($sm,$smc)){ foreach($t in @((Join-Path $base 'Charon Code'),(Join-Path $base 'Charon Code.lnk'))){ if(Test-Path $t){ Remove-Item $t -Recurse -Force; Write-Host ('  [4/5] removed: '+$t) } } }; foreach($dd in @((Join-Path $env:USERPROFILE 'Desktop'),(Join-Path $env:PUBLIC 'Desktop'))){ $l=Join-Path $dd 'Charon Code.lnk'; if(Test-Path $l){ Remove-Item $l -Force; Write-Host ('  [4/5] removed: '+$l) } }; foreach($k in $keys){ Remove-Item $k -Recurse; Write-Host ('  [5/5] removed registry key: '+$k) }; Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Charon Code'; Write-Host '  [5/5] registry cleaned' }"

echo.
echo ============================================================
echo   DONE. Charon Code is fully removed from this PC.
echo ============================================================
pause
endlocal
