@echo off
REM Test Alchemist launcher (Windows) — double-click to start the server.
REM Optional: pass a port  ->  start.bat 3005
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo Node.js 18+ is required. Install it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not "%~1"=="" set PORT=%~1
if not defined PORT set PORT=35000

if not exist node_modules (
    echo Installing dependencies ^(first run only^)...
    call npm install
)

echo.
echo   Test Alchemist  -^>  http://localhost:%PORT%
echo   (close this window or run stop.bat to stop)
echo.
node server.js
