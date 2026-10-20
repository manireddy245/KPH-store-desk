@echo off
rem Starts Kanakapatnam Store Desk on the shop server PC.
rem Put a shortcut to this file in the Startup folder (Win+R, type shell:startup) so it starts by itself when the PC is switched on.
rem Keep this window open while the shop is working. To stop: shut down Windows normally, or close this window.
cd /d "%~dp0"
title Kanakapatnam Store Desk - keep this window open
call pnpm start
echo.
echo Store Desk has stopped. Close this window, or press a key to start it again.
pause >nul
goto :eof
