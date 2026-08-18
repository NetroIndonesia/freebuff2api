@echo off
setlocal EnableExtensions
title freebuff2api - install & start
echo.
echo  ==============================================
echo    freebuff2api - one-click install and start
echo  ==============================================
echo.

REM ------------------------------------------------------------------ Node --
where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo          Install Node.js 20 or newer from https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VER=%%v"
for /f "tokens=1 delims=." %%m in ("%NODE_VER%") do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% LSS 20 (
    echo  [ERROR] Node.js %NODE_VER% is too old. Need 20+.
    echo          Install a current version from https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo  [1/3] Node.js %NODE_VER% - OK

REM -------------------------------------------------------------- install --
echo  [2/3] Installing dependencies (npm install)...
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed. If better-sqlite3 failed to build,
    echo          install Visual Studio Build Tools ^(Desktop C++ workload^)
    echo          and re-run this script.
    echo.
    pause
    exit /b 1
)

REM --------------------------------------------------------------- config --
if not exist .env (
    copy .env.example .env >nul
    echo  [3/3] Created .env from .env.example
    echo          ^> edit .env to add FREEBUFF_TOKEN / PROXIES, or skip and
    echo            add them from the dashboard Settings tab after startup.
) else (
    echo  [3/3] Found existing .env - keeping it
)

REM Load .env into this session (the server reads env vars, not the file).
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" set "%%a=%%b"
)

REM ---------------------------------------------------------------- start --
echo.
echo  Starting freebuff2api on http://localhost:8787
echo    Dashboard : http://localhost:8787
echo    API base  : http://localhost:8787/v1
echo    (Ctrl+C to stop)
echo.
node server.js
