#!/bin/bash
# Office Tracker - macOS Active Window & Application Detection
# Queries System Events via osascript for the frontmost application process and window title.

osascript 2>/dev/null <<'EOF'
global frontApp, frontAppName, windowTitle
set windowTitle to ""
try
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set frontAppName to name of frontApp
    tell process frontAppName
      if exists (1st window whose value of attribute "AXMain" is true) then
        set windowTitle to value of attribute "AXTitle" of (1st window whose value of attribute "AXMain" is true)
      end if
    end tell
  end tell
  return "{\"process\":\"" & frontAppName & "\",\"title\":\"" & windowTitle & "\"}"
on error
  return "{\"process\":\"unknown\",\"title\":\"\"}"
end try
EOF
