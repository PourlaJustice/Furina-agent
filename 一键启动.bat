@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_BIN=%~dp0node-portable"
if exist "%NODE_BIN%\node.exe" (
    set "PATH=%NODE_BIN%;%NODE_BIN%\node_modules\npm\bin;%PATH%"
    echo [使用内置便携版 Node 24]
) else (
    where node >nul 2>nul
    if errorlevel 1 (
        echo [未找到 Node.js：请安装 Node.js 24 LTS，或保留内置 node-portable 目录]
        pause
        exit /b 1
    )
)
echo [正在启动芙宁娜桌宠，请稍候...]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-furina.ps1"
echo.
pause
