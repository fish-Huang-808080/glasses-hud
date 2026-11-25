# Register scheduled task glasses-hud-bridge: start at logon, retry on failure, no time limit.
# Idempotent: re-running keeps exactly one task and removes tasks registered by older
# versions of this script under previous repository names (only if they point at this folder).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'glasses-hud-bridge'

foreach ($old in @('xiaoma-hud-bridge', 'zcode-glasses-bridge')) {
  $oldTask = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
  if ($null -ne $oldTask) {
    $pointsHere = $oldTask.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($root) }
    if ($pointsHere) {
      Stop-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $old -Confirm:$false
      Write-Output "removed old task: $old"
    } else {
      Write-Output "kept task '$old' (it points at another folder)"
    }
  }
}

$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  $mine = $existing.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($root) }
  if (-not $mine) { throw "task '$name' already exists but points elsewhere; not touching it" }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\run-bridge.ps1`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Description 'glasses-hud: ZCode state bridge (bridge.mjs, port 8790)' -Force | Out-Null
Write-Output "registered:"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-Table -AutoSize
