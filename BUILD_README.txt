ENDURANCE AUTOMATION - PORTABLE BUILD

1. Extract this kit into C:\Git\Endurance-Automation, replacing the project files.
2. Open PowerShell in that folder.
3. Run:

   powershell -ExecutionPolicy Bypass -File .\build-portable.ps1

4. Distribute:

   release\EnduranceAutomation_1.2.0_Portable.exe

The destination user only opens the EXE. Node.js, npm, Electron, Playwright browser
installation, and CMD are not required on the destination machine.

The app uses Microsoft Edge already installed on Windows, with Google Chrome as fallback.

If the portable target is blocked during build, run:

   powershell -ExecutionPolicy Bypass -File .\build-folder-fallback.ps1

Zip the complete release\win-unpacked folder. The user opens Endurance Automation.exe.
