@echo off
rem Usage in Command Prompt or Cmder: scripts\dev web   or   scripts\dev admin
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %1
