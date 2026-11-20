# 注册计划任务 glasses-hud-bridge：登录时启动 + 失败每分钟重试 + 无限运行时长
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\run-bridge.ps1`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'glasses-hud-bridge' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'glasses-hud: ZCode 状态桥 (bridge.mjs, port 8790)' -Force | Out-Null
Write-Output "registered:"
Get-ScheduledTask -TaskName 'glasses-hud-bridge' | Select-Object TaskName, State | Format-Table -AutoSize
