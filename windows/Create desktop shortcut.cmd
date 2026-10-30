@echo off
rem Puts a "Postbox" shortcut on your desktop and in the Start menu.
rem The console window starts minimized so the browser comes to the front.
setlocal
set "TARGET=%~dp0Postbox.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {" ^
  "  $s = $ws.CreateShortcut((Join-Path $dir 'Postbox.lnk'));" ^
  "  $s.TargetPath = $env:TARGET;" ^
  "  $s.WorkingDirectory = (Split-Path $env:TARGET);" ^
  "  $s.WindowStyle = 7;" ^
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
