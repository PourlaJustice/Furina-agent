@echo off
cd /d "%~dp0"
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "STAGE=%ROOT%\..\_pack_staging\Furina-agent"
set "STAGEPARENT=%ROOT%\..\_pack_staging"
set "ZIP=%ROOT%\..\Furina-agent-full-package.zip"
echo [1/3] Staging full project (models/browser/node/keys included; .git and logs excluded)...
rd /s /q "%STAGEPARENT%" 2>nul
robocopy "%ROOT%" "%STAGE%" /E /XD "%ROOT%\.git" "%ROOT%\dist" "%ROOT%\screenshots" /XF *.log renderer-log.txt furina-window.png /NFL /NDL /NJH /NP >nul
echo [2/3] Compressing (large, a few minutes)...
if exist "%ZIP%" del /f /q "%ZIP%"
tar -a -c -f "%ZIP%" -C "%STAGEPARENT%" Furina-agent
echo [3/3] Done! Package created:
echo     %ZIP%
rd /s /q "%STAGEPARENT%" 2>nul
echo.
pause
