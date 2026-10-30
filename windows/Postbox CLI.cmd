@echo off
rem Runs the bundled Postbox CLI using the portable Node.js runtime and the
rem Windows system certificate store (for corporate VPN endpoints).
rem Example:
rem   "Postbox CLI.cmd" run collection.json -e environment.json
setlocal
"%~dp0runtime\node.exe" --use-system-ca "%~dp0app\cli.mjs" %*
exit /b %ERRORLEVEL%
