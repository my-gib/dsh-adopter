# ensure-adopter.ps1 —— 一键确保 adopter 在跑（幂等）
#
# 由 ensure-adopter.cmd 调起（那个 .cmd 只负责绕过执行策略，全英文）。
# 逻辑都在这里，因为有 SQL 中文输出放在 cmd 里会被 GBK 解析搞坏。

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$port = 9320

function Test-Listening {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '    adopter 状态检查' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''

if (Test-Listening) {
  Write-Host '  [OK] adopter 已经在跑，不用动。' -ForegroundColor Green
} else {
  Write-Host '  [..] 9320 没在听，正在启动 adopter ...' -ForegroundColor Yellow
  # Start-Process 是异步的（别用 & 或 Start-Job 那种会等的方式）
  Start-Process -FilePath (Join-Path $root 'start-adopter.cmd') -WorkingDirectory $root -WindowStyle Hidden

  $waited = 0
  for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 1
    $waited = $i
    if (Test-Listening) { break }
  }

  if (Test-Listening) {
    Write-Host "  [OK] 启动成功（等了 $waited 秒）。" -ForegroundColor Green
  } else {
    Write-Host "  [X] 等了 $waited 秒还没起来。日志最后 15 行：" -ForegroundColor Red
    Write-Host ''
    $log = Join-Path $root 'logs\adopter.log'
    if (Test-Path $log) { Get-Content $log -Tail 15 } else { Write-Host '    （日志文件不存在）' }
    Write-Host ''
    Write-Host '  常见原因：专用 Edge 没装 / profile 被占用 / node 不在 PATH。' -ForegroundColor DarkGray
    return
  }
}

Write-Host ''
Write-Host '  ------------------------------------------------------------'
Write-Host '   通道状态（来自 9320/status）'
Write-Host '  ------------------------------------------------------------'
try {
  $r = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/status" -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
  foreach ($c in $r.channels) {
    $w = $c.window
    $send = if ($w -and $w.sendEnabled) { '可发' } else { '只读' }
    $line = '   {0}  已知 {1,3} 条   失败 {2}   {3}' -f $c.label.PadRight(10), $c.knownMessages, $c.failures, $send
    $color = if ($c.failures -gt 0) { 'Red' } else { 'Gray' }
    Write-Host $line -ForegroundColor $color
  }
} catch {
  Write-Host "   读状态失败：$($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ''
Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '   消息是直接进 DSH 会话的，不用在这里看。' -ForegroundColor DarkGray
Write-Host '   这个脚本只负责「确保它在跑」。' -ForegroundColor DarkGray
Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''
