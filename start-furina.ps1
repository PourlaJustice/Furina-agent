# 启动芙宁娜桌宠（后台运行，无需打开终端）
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot

# 如果桌宠已经在运行，就不重复启动
$already = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'furina-agent' -and $_.Name -eq 'electron.exe' }
if ($already) {
  Write-Host '桌宠已经在运行中，无需重复启动。' -ForegroundColor Yellow
  exit 0
}

# 清掉旧日志，后台启动开发服务器 + 桌宠
$out = Join-Path $root 'dev-restart.log'
$err = Join-Path $root 'dev-restart.err.log'
Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err

Write-Host '正在启动桌宠，请稍候…' -ForegroundColor Cyan
Start-Sleep -Seconds 10

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'furina-agent' -and $_.Name -eq 'electron.exe' }
if ($procs) {
  Write-Host '启动成功！芙宁娜应该已经出现在桌面上了。' -ForegroundColor Green
} else {
  Write-Host '启动似乎没有成功，请把下面的日志内容发给开发者：' -ForegroundColor Red
  if (Test-Path $out) { Get-Content -LiteralPath $out -Tail 20 }
  if (Test-Path $err) { Get-Content -LiteralPath $err -Tail 10 }
}