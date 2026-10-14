@echo off
REM ===========================================================================
REM  Burnhouse - build and start.
REM
REM  Windows will not run a .ps1 file by double-clicking, or by typing its name,
REM  unless the execution policy allows it - the default is Restricted, which
REM  blocks every script. That is a setting on the machine, not a problem with
REM  the file, and it applies to any PowerShell script you will ever download.
REM
REM  This wrapper asks PowerShell for a one-off bypass for this one script. It
REM  changes nothing about your machine and nothing about the policy.
REM
REM  Equivalent commands, if you prefer:
REM      powershell -ExecutionPolicy Bypass -File .\build-and-start.ps1
REM      npm run app
REM ===========================================================================

setlocal
set "SCRIPT=%~dp0build-and-start.ps1"

if not exist "%SCRIPT%" (
    echo.
    echo Could not find build-and-start.ps1 next to this file.
    echo Expected it at: %SCRIPT%
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

REM Double-clicked windows close the moment the script ends, which would hide
REM the summary and any error. Detect that case and hold the window open.
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause
if not "%CODE%"=="0" pause

exit /b %CODE%
