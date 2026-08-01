@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
start "" /MIN "%~dp0node_modules\.bin\electron.cmd" .
endlocal
