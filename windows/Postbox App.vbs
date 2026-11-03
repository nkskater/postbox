' Starts Postbox in its own window with no console window.
' Closing the Postbox window stops the app.
Option Explicit
Dim shell, fso, dir, q, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
shell.CurrentDirectory = dir
rc = shell.Run("cmd.exe /d /c " & q & q & dir & "\Postbox.cmd" & q & " --window" & q, 0, True)
If rc <> 0 Then
  MsgBox "Postbox could not start." & vbCrLf & vbCrLf & _
    "Details are in startup-error.log in your Data folder. " & _
    "You can also double-click Postbox.cmd to run it in a console window and see the error.", _
    vbExclamation, "Postbox"
End If
