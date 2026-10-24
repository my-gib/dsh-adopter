@echo off
rem Thin wrapper: cmd cannot parse UTF-8 Chinese reliably (it reads as GBK before
rem chcp takes effect), so all real logic lives in ensure-adopter.ps1.
rem
rem -ExecutionPolicy Bypass: this machine blocks .ps1 scripts.
rem powershell (not pwsh): Windows PowerShell 5.1 is what exists here; PS7 is not
rem installed. The .ps1 carries a UTF-8 BOM so 5.1 reads its Chinese correctly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-adopter.ps1"
echo.
pause
