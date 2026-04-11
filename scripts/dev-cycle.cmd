@echo off
REM Windows entrypoint — delegates to scripts/dev-cycle.ts via tsx.
REM Shares all logic with the Unix entrypoint (scripts/dev-cycle).

setlocal
cd /d "%~dp0.."
pnpm exec tsx "scripts\dev-cycle.ts" %*
exit /b %ERRORLEVEL%
