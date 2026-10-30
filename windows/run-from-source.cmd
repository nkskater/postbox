@echo off
rem Runs Postbox straight from a source checkout on a PC that already has
rem Node.js 22 or newer installed (https://nodejs.org). Builds the standalone
rem bundle the first time. Most users should use the packaged Windows zip
rem instead (npm run build:windows).
setlocal
title Postbox
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo Installing dependencies, this only happens once...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist ".next\standalone\server.js" (
  echo Building Postbox standalone bundle...
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not defined DATA_DIR set "DATA_DIR=%CD%\data"
if exist "windows\Settings.cmd" call "windows\Settings.cmd"
node --use-system-ca scripts\local-server.mjs
if errorlevel 1 (
  echo.
  pause
)
