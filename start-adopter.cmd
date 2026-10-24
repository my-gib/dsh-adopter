@echo off
rem Real launcher for dsh-adopter. Kept in a .cmd so paths and logging live in one
rem readable place; start-adopter.vbs only exists to run this without a console window.
rem
rem Manual start:  double-click this file, or `node adopter.mjs` in a terminal.
rem Logs:         logs\adopter.log

cd /d "%~dp0" || exit /b 1
if not exist logs mkdir logs

rem Do not start a second copy: port 9320 listening means one is already alive.
netstat -ano -p tcp | findstr ":9320" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [%date% %time%] launch skipped, 9320 already listening>> logs\adopter.log
  exit /b 0
)

echo. >> logs\adopter.log
echo [%date% %time%] launching adopter.mjs>> logs\adopter.log

rem Full path to node on purpose: the PATH seen at logon can differ from an interactive shell.
"C:\Program Files\nodejs\node.exe" adopter.mjs >> logs\adopter.log 2>&1

echo [%date% %time%] adopter.mjs exited with %errorlevel%>> logs\adopter.log
