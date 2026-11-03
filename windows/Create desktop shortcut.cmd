@echo off
rem Puts a "Postbox" shortcut on your desktop and in the Start menu.
rem The shortcuts open Postbox in its own window (no console window).
setlocal
set "TARGET=%~dp0Postbox App.vbs"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $s = $ws.CreateShortcut((Join-Path $dir 'Postbox.lnk'));" ^
  "  $s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe';" ^
  "  $s.Arguments = '\"' + $env:TARGET + '\"';" ^
  "  $s.WorkingDirectory = (Split-Path $env:TARGET);" ^
  "  $s.WindowStyle = 1;" ^
  "  $s.IconLocation = (Join-Path (Split-Path $env:TARGET) 'app\app.ico') + ',0';" ^
  "  $s.Description = 'Postbox API Client';" ^
  "  $s.Save() }"
if errorlevel 1 (
  echo Could not create the shortcuts.
) else (
  echo Shortcuts created on your desktop and in the Start menu.
)
echo.
pause
