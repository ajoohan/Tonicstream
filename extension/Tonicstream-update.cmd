@echo off
rem Tonicstream update: downloads the latest version into this folder. Double-click to run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tonicstream-update.ps1" & exit /b
