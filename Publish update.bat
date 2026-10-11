@echo off
setlocal
cd /d "%~dp0"
title Publish a xan update

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

node scripts\release.js %*
echo.
pause
