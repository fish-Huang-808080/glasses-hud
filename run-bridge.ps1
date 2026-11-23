# glasses-hud bridge 启动器（计划任务调用）
# - 单实例：已有健康服务则直接退出
# - 日志：.state/bridge.log, .state/bridge.err.log
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
New-Item -ItemType Directory -Force -Path '.state' | Out-Null

# 已有实例在跑就不再启动（计划任务重试时避免端口冲突）
try {
  $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8790/health' -TimeoutSec 3
  if ($r.StatusCode -eq 200) { exit 0 }
} catch {}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "$env:ProgramFiles\nodejs\node.exe" }

# 本地个性化（不入库）：.state/local.env 里每行 KEY=VALUE，会注入为环境变量
#   例：HUD_ASSISTANT_NAME=你给 bridge 起的称呼
$envFile = Join-Path $root '.state\local.env'
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $k, $v = $line.Split('=', 2)
      Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
    }
  }
}

# 清掉可能残留的旧进程：按脚本所在目录匹配，目录叫什么都能用
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine -like '*bridge.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep 1
Start-Process -FilePath $node -ArgumentList 'bridge/bridge.mjs', '--host', '0.0.0.0' `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput "$root\.state\bridge.log" `
  -RedirectStandardError "$root\.state\bridge.err.log"
