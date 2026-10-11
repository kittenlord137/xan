@echo off
setlocal
cd /d "%~dp0"
title Build xan

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

call npm install --no-audit --no-fund
if errorlevel 1 ( pause & exit /b 1 )
call npm run dist
if errorlevel 1 ( pause & exit /b 1 )

echo.
echo Done. Look in the "dist" folder: the installer and a portable xan.exe are there.
start "" "%~dp0dist"
pause
