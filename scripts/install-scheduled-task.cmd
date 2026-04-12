@echo off
REM Cmd wrapper for install-scheduled-task.ps1 — invokes under gsudo so
REM the -Highest path (and anything else that ends up needing elevation)
REM works without you having to remember the pwsh syntax.
REM
REM Forwards all arguments to the underlying PowerShell script.
REM
REM Usage:
REM   scripts\install-scheduled-task.cmd
REM   scripts\install-scheduled-task.cmd -Time 06:15
REM   scripts\install-scheduled-task.cmd -Highest
REM   scripts\install-scheduled-task.cmd -Uninstall

setlocal

where gsudo >nul 2>nul
if errorlevel 1 (
    echo ERROR: gsudo is not on PATH. Install it from https://github.com/gerardog/gsudo 1>&2
    exit /b 127
)

gsudo pwsh -NoProfile -File "%~dp0install-scheduled-task.ps1" %*
exit /b %ERRORLEVEL%
