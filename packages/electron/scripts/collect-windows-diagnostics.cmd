@echo off
setlocal
set "SCRIPT=%~dp0collect-windows-diagnostics.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Diagnostics collection failed with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
