#!/bin/bash
set -euo pipefail
# No --no-sandbox: fail rather than silently disable Chromium's isolation.
exec chromium --no-first-run --disable-dev-shm-usage --disable-session-crashed-bubble \
  --proxy-server="${CHROMIUM_PROXY:?Desktop proxy required}" --proxy-bypass-list='<-loopback>' \
  --user-data-dir="$HOME/.config/chromium" --start-maximized "$@"
