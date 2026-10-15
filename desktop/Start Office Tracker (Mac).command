#!/bin/bash
cd "$(dirname "$0")"
defaults write com.officetracker.desktop NSAppSleepDisabled -bool YES 2>/dev/null || true
defaults write com.rethink.officetracker.desktop NSAppSleepDisabled -bool YES 2>/dev/null || true
echo "Starting Office Tracker Workstation Agent..."
exec caffeinate -i node run-agent.js
