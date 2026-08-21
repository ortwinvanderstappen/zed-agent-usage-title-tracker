@echo off
rem Launcher for the "command" field of a Zed custom agent server.
rem
rem Zed ships its own node in a version-stamped directory
rem (%LOCALAPPDATA%\Zed\node\node-v24.11.0-win-x64) which is replaced whenever
rem Zed upgrades node, so resolving it here rather than writing it into
rem settings.json keeps that setting from going stale. Any arguments are passed
rem through to proxy.mjs, e.g. --provider codex.
setlocal

set "NODE_BIN="

if defined ZED_AGENT_USAGE_NODE if exist "%ZED_AGENT_USAGE_NODE%" set "NODE_BIN=%ZED_AGENT_USAGE_NODE%"

if not defined NODE_BIN if defined LOCALAPPDATA (
  rem /o-d lists most recently written first, so Zed's newest node wins.
  for /f "delims=" %%d in ('dir /b /ad /o-d "%LOCALAPPDATA%\Zed\node\node-v*" 2^>nul') do (
    if not defined NODE_BIN if exist "%LOCALAPPDATA%\Zed\node\%%d\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Zed\node\%%d\node.exe"
  )
)

if not defined NODE_BIN set "NODE_BIN=node"

"%NODE_BIN%" "%~dp0..\proxy.mjs" %*
exit /b %ERRORLEVEL%
