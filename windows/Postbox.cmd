@echo off
rem Starts Postbox locally on 127.0.0.1 and opens it in your web browser.
rem Keep the window that opens; closing it stops the app.
rem
rem "Postbox.cmd --window" opens Postbox in its own app window instead (needs
rem Microsoft Edge or Google Chrome) and stops when that window is closed.
setlocal
title Postbox

rem Default data folder: "Data" next to this script (portable folder).
rem Override in "Settings.cmd" next to this file (never overwritten by updates).
if not defined DATA_DIR set "DATA_DIR=%~dp0Data"
if exist "%~dp0Settings.cmd" call "%~dp0Settings.cmd"

"%~dp0runtime\node.exe" --use-system-ca "%~dp0app\local.mjs" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  if /i not "%~1"=="--window" (
    echo.
    pause
  )
)
exit /b %RC%
