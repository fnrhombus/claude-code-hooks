@echo off
REM Windows entrypoint — delegates to scripts/dev-cycle.ts via mise-managed
REM tsx. Shares all logic with the Unix entrypoint (scripts/dev-cycle).

setlocal
cd /d "%~dp0.."
mise exec -- tsx "scripts\dev-cycle.ts" %*
exit /b %ERRORLEVEL%
