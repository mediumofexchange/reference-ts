@echo off
rem The 10^6 design-point run (WORK.md slice 18) under keep.mjs, which restarts a failed driver and resumes it from the
rem journal's count. Started at logon by moe-dp6.vbs in the Startup folder; keep.mjs removes that entry when the report is done.
rem moe-dp6.vbs holds these two lines (re-create it at %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\moe-dp6.vbs):
rem   ' 10^6 design-point run (reference-ts WORK.md slice 18): starts its keeper hidden at logon; removed when the run is done.
rem   CreateObject("WScript.Shell").Run "cmd /c ""<checkout>\scratch\dp6\launch.cmd""", 0, False
cd /d %~dp0
set "DPR_STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\moe-dp6.vbs"
node keep.mjs --marks 100000,1000000 --step 200 --holdings-cap 25000 >> keep-out.log 2>&1
