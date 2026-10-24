' Starts dsh-adopter with no console window.
'
' Install for autostart: copy or shortcut this file into
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
' Remove it from there to disable autostart. All it does is call start-adopter.cmd
' in the same folder as this script.

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & here & "\start-adopter.cmd""", 0, False
