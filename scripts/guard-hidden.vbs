' Windowless launcher - entry point for the scheduled task.
'
' Why: when Task Scheduler starts a console program (powershell.exe) under an
' interactive principal, Windows allocates a console window and flashes it on
' every run; -WindowStyle Hidden cannot prevent that first flash. wscript.exe is
' a GUI host (no console), and Run(..., 0, False) starts PowerShell hidden, so
' the whole chain stays invisible.
'
' ASCII ONLY (same codepage reasoning as gateway-guard.ps1).
Option Explicit
Dim shell, fso, here, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\gateway-guard.ps1"""
shell.Run cmd, 0, False
