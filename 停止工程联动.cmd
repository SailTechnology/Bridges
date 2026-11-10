@echo off
powershell.exe -NoProfile -File "%~dp0scripts\Stop-Bridges.ps1"
if errorlevel 1 pause
