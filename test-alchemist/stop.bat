@echo off
REM Stop Test Alchemist (frees the server port).
REM Defaults to port 35000; pass another  ->  stop.bat 3005
if not "%~1"=="" (set PORT=%~1) else (set PORT=35000)
echo Stopping Test Alchemist on port %PORT% ...

set FOUND=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>nul
    if not errorlevel 1 set FOUND=1
)

if defined FOUND (
    echo Test Alchemist stopped.
) else (
    echo No Test Alchemist server was running on port %PORT%.
)

ping 127.0.0.1 -n 2 >nul
