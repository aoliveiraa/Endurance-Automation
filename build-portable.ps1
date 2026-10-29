$ErrorActionPreference = "Stop"
Write-Host "Building Endurance Automation portable package..." -ForegroundColor Cyan
npm install
npm run build:portable
Write-Host "Portable package created under .\release" -ForegroundColor Green
Get-ChildItem ".\release\*Portable.exe" | Select-Object Name, Length, LastWriteTime
