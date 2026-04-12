<#
.SYNOPSIS
  Install (or update) the Windows scheduled task that runs the autonomous
  type-sync pipeline for @fnrhombus/claude-code-hooks.

.DESCRIPTION
  Registers a scheduled task named "claude-code-hooks-sync" that runs
  scripts/dev-cycle.ts once a day via tsx. Idempotent: re-running replaces
  the existing task with the current definition.

  No elevation required — tasks in the current user's folder can be
  created without admin rights. If you want a higher privilege task
  (e.g. -RunLevel Highest), re-run under gsudo:

      gsudo pwsh -File scripts/install-scheduled-task.ps1 -Highest

.PARAMETER Time
  Local time of day to run the task. Default 03:30.

.PARAMETER TaskName
  Name of the scheduled task. Default "claude-code-hooks-sync".

.PARAMETER TaskPath
  Task Scheduler folder to install the task into. Default "\rhombus\"
  (groups all fnrhombus tasks together in the Task Scheduler UI). The
  folder is created automatically if it doesn't exist.

.PARAMETER Highest
  Run with highest privileges. Requires elevation (use gsudo).

.PARAMETER Uninstall
  Remove the task instead of installing it.

.EXAMPLE
  pwsh -File scripts/install-scheduled-task.ps1
  # Installs the task, running daily at 03:30 as the current user.

.EXAMPLE
  pwsh -File scripts/install-scheduled-task.ps1 -Time "06:15"
  # Runs at 06:15 instead.

.EXAMPLE
  pwsh -File scripts/install-scheduled-task.ps1 -Uninstall
  # Removes the task.
#>

[CmdletBinding()]
param(
    [string]$Time = "03:30",
    [string]$TaskName = "claude-code-hooks-sync",
    [string]$TaskPath = "\rhombus\",
    [switch]$Highest,
    [switch]$Uninstall
)

# Normalize the TaskPath: Register-ScheduledTask requires it to start
# and end with a backslash.
if (-not $TaskPath.StartsWith("\")) { $TaskPath = "\" + $TaskPath }
if (-not $TaskPath.EndsWith("\"))   { $TaskPath = $TaskPath + "\" }

$ErrorActionPreference = "Stop"

# Resolve repo root relative to this script — works regardless of where
# it's invoked from.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..")
$DevCycleTs = Join-Path $RepoRoot "scripts\dev-cycle.ts"

if (-not (Test-Path $DevCycleTs)) {
    throw "Could not find $DevCycleTs — are you running this from inside the claude-code-hooks repo?"
}

# ----------------------------------------------------------------------------
# Uninstall path
# ----------------------------------------------------------------------------

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Task '$TaskPath$TaskName' is not registered — nothing to remove."
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-Host "Removed scheduled task '$TaskPath$TaskName'."
    exit 0
}

# ----------------------------------------------------------------------------
# Resolve pnpm.exe — tasks run outside the interactive shell and may not
# have mise-activated PATH, so we embed the full path at install time.
# ----------------------------------------------------------------------------

$pnpm = (Get-Command pnpm.exe -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
    $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
}
if (-not $pnpm) {
    throw @"
pnpm is not on PATH. Activate mise (or install pnpm globally) before
running this script:

    mise install         # installs pnpm per .mise.toml
    pnpm --version       # verify it's on PATH

Then re-run install-scheduled-task.ps1.
"@
}

Write-Host "Resolved pnpm: $pnpm"
Write-Host "Repo root:     $RepoRoot"
Write-Host "Dev cycle:     $DevCycleTs"
Write-Host "Schedule:      daily at $Time"
Write-Host ""

# ----------------------------------------------------------------------------
# Task definition
# ----------------------------------------------------------------------------

$action = New-ScheduledTaskAction `
    -Execute $pnpm `
    -Argument "exec tsx scripts/dev-cycle.ts" `
    -WorkingDirectory $RepoRoot.Path

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Minutes 10)

$principalArgs = @{
    UserId    = "$env:USERDOMAIN\$env:USERNAME"
    LogonType = "Interactive"
}
if ($Highest) {
    $principalArgs.RunLevel = "Highest"
}
$principal = New-ScheduledTaskPrincipal @principalArgs

$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Autonomous upstream-hook-types sync pipeline for @fnrhombus/claude-code-hooks. Runs scripts/dev-cycle.ts which short-circuits if nothing changed."

# ----------------------------------------------------------------------------
# Idempotent register — update if exists, create if not
# ----------------------------------------------------------------------------

$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Task '$TaskPath$TaskName' already exists — replacing."
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
}

# Register-ScheduledTask auto-creates the folder on first install, so we
# don't need to mess with the Task Scheduler COM object manually.
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task | Out-Null

Write-Host ""
Write-Host "✓ Registered scheduled task '$TaskPath$TaskName'." -ForegroundColor Green
Write-Host ""
Write-Host "Inspect it with:"
Write-Host "    Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "Trigger a run right now with:"
Write-Host "    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath"
Write-Host ""
Write-Host "Uninstall with:"
Write-Host "    pwsh -File scripts/install-scheduled-task.ps1 -Uninstall"
Write-Host ""

# ----------------------------------------------------------------------------
# Auto-close countdown — 10s with live updating, cancel on any key press.
# Only runs if we were launched into a transient console that would close
# on exit. If the parent process is a known persistent terminal, the user
# will have the output in front of them as long as they want it.
# ----------------------------------------------------------------------------

function Test-PersistentParentTerminal {
    # Walk the process ancestry tree looking for either a GUI terminal
    # host (definitively persistent) or a launcher like explorer/services
    # (definitively transient). Shells like cmd/pwsh/bash/gsudo are
    # intermediate — we walk *through* them without deciding.
    #
    # Examples:
    #   Terminal: WindowsTerminal → pwsh → cmd → pwsh(this)
    #     walk finds WindowsTerminal, return true
    #   Double-click .cmd: explorer → cmd → pwsh(this)
    #     walk finds explorer, return false
    #   gsudo from terminal: WindowsTerminal → pwsh → gsudo → pwsh(this)
    #     walk skips gsudo, finds WindowsTerminal, return true
    #   gsudo double-clicked: explorer → cmd → gsudo → pwsh(this)
    #     walk skips gsudo+cmd, finds explorer, return false

    $guiTerminals = @(
        "WindowsTerminal", "OpenConsole",
        "mintty", "ConEmu", "ConEmu64",
        "alacritty", "wezterm", "kitty",
        # VS Code / Cursor integrated terminals
        "Code", "Code - Insiders", "Cursor", "devenv"
    )
    $transientRoots = @(
        "explorer", "svchost", "services", "winlogon", "csrss", "wininit"
    )

    $currentId = $PID
    for ($depth = 0; $depth -lt 12; $depth++) {
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction Stop
            $parentId = $proc.ParentProcessId
            if (-not $parentId -or $parentId -eq 0) { return $false }
            $parent = Get-Process -Id $parentId -ErrorAction Stop
        } catch {
            # Parent died or inaccessible — default to transient.
            return $false
        }

        $name = $parent.ProcessName
        if ($guiTerminals   -icontains $name) { return $true  }
        if ($transientRoots -icontains $name) { return $false }

        # Intermediate shell or gsudo — keep walking.
        $currentId = $parentId
    }
    # Ran out of depth — default to transient.
    return $false
}

if (Test-PersistentParentTerminal) {
    # Nothing to do — the user has a persistent window. Exit cleanly.
    exit 0
}

# Drain any keypresses that buffered up while the install ran, so the
# loop below doesn't instantly exit on a stale enter/space.
while ([Console]::KeyAvailable) { [Console]::ReadKey($true) | Out-Null }

# Right-pad number to 2 chars ({0,2}) and swap the "s" in "seconds" for a
# space when count is 1, so every rendered line is exactly the same
# width — no residual chars leaking between frames.
$msgFmt = "`rClosing in {0,2} second{1}. Press any key to exit now."
$cancelled = $false
for ($remaining = 10; $remaining -gt 0; $remaining--) {
    $plural = if ($remaining -eq 1) { " " } else { "s" }
    Write-Host ($msgFmt -f $remaining, $plural) -NoNewline -ForegroundColor DarkGray
    # Poll 10x per second so key-press response feels immediate instead of
    # lagging by up to a full second.
    for ($tick = 0; $tick -lt 10; $tick++) {
        if ([Console]::KeyAvailable) {
            [Console]::ReadKey($true) | Out-Null
            $cancelled = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if ($cancelled) { break }
}
Write-Host ""
