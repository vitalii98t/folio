@echo off
cd /d "%~dp0"

echo [0/3] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [1/3] Building main process...
"C:\Program Files\nodejs\node.exe" build-main.mjs
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)

echo [2/3] Starting Vite dev server...
start /B "" "C:\Program Files\nodejs\npx.cmd" vite --port 5173 --strictPort

echo Waiting for Vite...
timeout /t 3 /nobreak > nul

echo [3/3] Launching Electron...
"node_modules\electron\dist\electron.exe" .

echo Shutting down...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
