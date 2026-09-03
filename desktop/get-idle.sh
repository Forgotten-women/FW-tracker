#!/bin/bash
# Office Tracker - macOS Idle Time Detection
# Queries IOHIDSystem for HIDIdleTime (nanoseconds since last keyboard/mouse event)
# and outputs idle time in whole seconds.

idle_nano=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}')
if [ -n "$idle_nano" ]; then
  echo $((idle_nano / 1000000000))
else
  echo 0
fi
