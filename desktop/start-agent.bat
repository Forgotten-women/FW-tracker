@echo off
title Office Tracker Desktop
cd /d "%~dp0"
echo Starting Office Tracker Workstation Agent...
node run-agent.js
pause
