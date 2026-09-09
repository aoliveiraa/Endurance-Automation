@echo off
title Endurance Helper

echo.
echo ====================================
echo Endurance Helper
echo ====================================
echo.

set /p REPORT_URL=Cole a URL do report:

echo.
echo Executando...
echo.

node endurance.js "%REPORT_URL%"

pause