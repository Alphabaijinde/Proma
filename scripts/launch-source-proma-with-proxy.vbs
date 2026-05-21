Option Explicit

Dim shell, command
Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\admin\Proma\scripts\start-source-proma-with-proxy.ps1"""
shell.Run command, 0, False
