$ErrorActionPreference = "Stop"
Write-Host "Building unpacked fallback package..." -ForegroundColor Cyan
npm install
npm run build:folder
Write-Host "Fallback created under .\release\win-unpacked" -ForegroundColor Green
