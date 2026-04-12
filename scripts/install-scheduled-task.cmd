@echo off
REM Cmd wrapper for install-scheduled-task.ps1 — saves you the
REM `pwsh -NoProfile -File ...` typing. Invokes pwsh directly by default
REM (user-level scheduled tasks don't need elevation), and only escalates
REM through gsudo if you pass -Highest.
REM
REM Forwards all arguments to the underlying PowerShell script.
REM
REM Usage:
REM   scripts\install-scheduled-task.cmd
REM   scripts\install-scheduled-task.cmd -Time 06:15
REM   scripts\install-scheduled-task.cmd -Highest         (auto-elevates via gsudo)
REM   scripts\install-scheduled-task.cmd -Uninstall

setlocal

REM Check whether -Highest appears anywhere in the args.
set "NEEDS_ELEVATION="
for %%A in (%*) do (
    if /i "%%~A"=="-Highest" set "NEEDS_ELEVATION=1"
)

if defined NEEDS_ELEVATION (
    where gsudo >nul 2>nul
    if errorlevel 1 (
        echo ERROR: -Highest requires gsudo for elevation. Install it from https://github.com/gerardog/gsudo 1>&2
        exit /b 127
    )
    gsudo pwsh -NoProfile -File "%~dp0install-scheduled-task.ps1" %*
    exit /b %ERRORLEVEL%
)

pwsh -NoProfile -File "%~dp0install-scheduled-task.ps1" %*
exit /b %ERRORLEVEL%
