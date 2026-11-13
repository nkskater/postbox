; Installer hooks for Postbox Desktop (per-user NSIS installer).
;
; The window process (postbox-desktop.exe) runs the server as
; runtime\postbox-node.exe. Closing the window stops the server, but an upgrade
; or uninstall must not start while that server still holds files in the
; install folder, so wait for it and stop it as a last resort.

!macro POSTBOX_STOP_RUNNING_APP
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !define POSTBOX_WAIT_ID ${__LINE__}

  ; Up to 10 seconds (20 x 500 ms) for the server to stop by itself.
  StrCpy $R9 0
  postbox_wait_${POSTBOX_WAIT_ID}:
    nsis_tauri_utils::FindProcessCurrentUser "postbox-node.exe"
    Pop $R8
    ${If} $R8 = 0
    ${AndIf} $R9 < 20
      Sleep 500
      IntOp $R9 $R9 + 1
      Goto postbox_wait_${POSTBOX_WAIT_ID}
    ${EndIf}

  ${If} $R8 = 0
    nsis_tauri_utils::KillProcessCurrentUser "postbox-node.exe"
    Pop $R8
    Sleep 500
  ${EndIf}
  !undef POSTBOX_WAIT_ID
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro POSTBOX_STOP_RUNNING_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro POSTBOX_STOP_RUNNING_APP
!macroend

; The database, vault key file, backups and logs live in %LOCALAPPDATA%\Postbox.
; Remove them only when "Delete application data" was ticked, never on upgrade.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\Postbox"
  ${EndIf}
!macroend
