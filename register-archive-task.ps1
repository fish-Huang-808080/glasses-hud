# Register scheduled task glasses-hud-archive: every 6 hours, pull Feishu minutes / agenda /
# tasks into a local, append-only raw layer (read-only against Feishu).
# Idempotent: re-running keeps exactly one task.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 files using the system
# code page, and non-ASCII characters can corrupt string literals and line continuation.
#
# The data directory lives OUTSIDE the repository (the repository is public). Its location
# must match the default in archive/feishu-archive.mjs.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { throw 'cannot determine script directory ($PSScriptRoot is empty)' }
$name = 'glasses-hud-archive'

$dataRoot = Join-Path (Split-Path -Parent $root) 'glasses-hud-data'
$workDir = Join-Path $dataRoot '_work'   # lark-cli writes into cwd; keep it out of the repository
$script = Join-Path $root 'archive\feishu-archive.mjs'
foreach ($p in @($dataRoot, $workDir)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
if (-not (Test-Path $script)) { throw "archive script not found: $script" }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "$env:ProgramFiles\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw 'node.exe not found' }

# Repeat for 10 years. [TimeSpan]::MaxValue is rejected by Task Scheduler (out of range).
# Re-run this script to extend when it expires.
$repeatFor = New-TimeSpan -Days 3650
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$script`" --root `"$dataRoot`" --days 30" `
  -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration $repeatFor
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Description 'glasses-hud: archive Feishu minutes/agenda/tasks to local raw layer (read-only)' -Force | Out-Null

Write-Output "registered: $name"
Write-Output "data root: $dataRoot"
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-Table -AutoSize
