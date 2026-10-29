@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)
call npm start
exit /b %errorlevel%
:error
echo.
echo Unable to start Endurance Automation.
pause
exit /b 1
