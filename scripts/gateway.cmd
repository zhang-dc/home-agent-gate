@echo off
REM agentgate launcher, started by gateway-guard.ps1 (or by hand).
REM ASCII ONLY IN THIS FILE: cmd.exe reads .cmd files in the OEM codepage,
REM so non-ASCII comments get mangled into bogus commands.
REM Output is appended to state\gateway.log (the admin panel tails the same file).
REM node.exe must be on PATH (Node 22+); dependencies installed with pnpm install.
setlocal
cd /d "%~dp0.."
if not exist state mkdir state
if not defined GATEWAY_LOG_LEVEL set "GATEWAY_LOG_LEVEL=info"
node --import tsx src/index.ts >> state\gateway.log 2>&1
echo [launcher] node exited with code %ERRORLEVEL% >> state\gateway.log
endlocal
