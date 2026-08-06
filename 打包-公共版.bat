@echo off
cd /d "%~dp0"
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "STAGE=%ROOT%\..\_pack_staging_public\Furina-agent"
set "STAGEPARENT=%ROOT%\..\_pack_staging_public"
set "ZIP=%ROOT%\..\Furina-agent-public-package.zip"
echo [1/4] Staging project (no keys / cookies / voice data / chat history)...
rd /s /q "%STAGEPARENT%" 2>nul
robocopy "%ROOT%" "%STAGE%" /E /XD "%ROOT%\.git" "%ROOT%\dist" "%ROOT%\screenshots" "%ROOT%\voice\ref" "%ROOT%\voice\out" "%ROOT%\.playwright-mcp" /XF *.log renderer-log.txt furina-window.png /NFL /NDL /NJH /NP >nul
echo [2/4] Replacing personal config with clean template...
if exist "%STAGE%\mcp-servers.json" del /f /q "%STAGE%\mcp-servers.json"
copy /y "%STAGE%\mcp-servers.example.json" "%STAGE%\mcp-servers.json" >nul
if exist "%STAGE%\vendor\netease-music-mcp\.listening-state.json" del /f /q "%STAGE%\vendor\netease-music-mcp\.listening-state.json"
if exist "%STAGE%\data\furina.db" del /f /q "%STAGE%\data\furina.db"
if exist "%ROOT%\使用说明-公共版.txt" copy /y "%ROOT%\使用说明-公共版.txt" "%STAGE%\使用说明.txt" >nul
echo [3/4] Creating empty chat database...
pushd "%STAGE%"
"%STAGE%\node-portable\node.exe" -e "const{DatabaseSync}=require('node:sqlite');const fs=require('fs');fs.mkdirSync('data',{recursive:true});const db=new DatabaseSync('data/furina.db');db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at); CREATE TABLE IF NOT EXISTS chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);');db.close();"
popd
echo [4/4] Compressing (a few minutes)...
if exist "%ZIP%" del /f /q "%ZIP%"
tar -a -c -f "%ZIP%" -C "%STAGEPARENT%" Furina-agent
echo Done! Public package created:
echo     %ZIP%
rd /s /q "%STAGEPARENT%" 2>nul
echo.
pause