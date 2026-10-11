@echo off
setlocal
cd /d "%~dp0"
title xan

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet.
  echo.
  echo 1. Install the "LTS" version from https://nodejs.org
  echo 2. Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First start: downloading what xan needs. This takes a few minutes and only happens once.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo The download failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
