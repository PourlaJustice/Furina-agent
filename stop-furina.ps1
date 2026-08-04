# 关闭芙宁娜桌宠（只关闭本项目的相关进程，不影响其他程序）
$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'furina-agent' -and $_.Name -in @('electron.exe', 'node.exe') }
if (-not $procs) {
  Write-Host '桌宠当前没有在运行。' -ForegroundColor Yellow
  exit 0
}

$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$left = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'furina-agent' -and $_.Name -in @('electron.exe', 'node.exe') }
if ($left) {
  Write-Host ('关闭完成（还有 ' + $left.Count + ' 个进程会在稍后自动退出）。') -ForegroundColor Green
} else {
  Write-Host '桌宠已完全关闭。' -ForegroundColor Green
}