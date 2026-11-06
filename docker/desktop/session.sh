#!/bin/bash
set -euo pipefail
xfce4-session &
session=$!
for attempt in {1..100}; do pgrep -x xfwm4 >/dev/null && break; sleep .2; done
/opt/desktop/browser.sh file:///opt/desktop/welcome.html >/tmp/browser.log 2>&1 &
browser=$!
sleep 2
kill -0 "$browser" || { cat /tmp/browser.log >&2; exit 1; }
touch /tmp/.X11-unix/cloud-work-ready
wait "$session"
