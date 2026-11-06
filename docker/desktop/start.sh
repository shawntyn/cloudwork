#!/bin/bash
set -euo pipefail
export DISPLAY=:99 HOME=/home/node XDG_RUNTIME_DIR=/tmp/runtime-node
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config" /workspace/Downloads /workspace/Documents /workspace/Desktop
chmod 700 "$XDG_RUNTIME_DIR"
trap 'kill $(jobs -pr) 2>/dev/null || true' EXIT
trap 'exit 0' TERM INT
rm -f /tmp/.X11-unix/cloud-work-ready
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# X is local-only. VNC is served by the separately authenticated controller.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac &
for attempt in {1..100}; do xdpyinfo >/dev/null 2>&1 && break; sleep .2; done
xdpyinfo >/dev/null
xset s off -dpms
for name in Desktop Downloads Documents; do ln -sfn "/workspace/$name" "$HOME/$name"; done
if [[ ! -f "$HOME/.config/user-dirs.dirs" ]]; then
  printf 'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DOCUMENTS_DIR="$HOME/Documents"\n' > "$HOME/.config/user-dirs.dirs"
fi
rm -f "$HOME/.config/chromium/SingletonLock" "$HOME/.config/chromium/SingletonSocket" "$HOME/.config/chromium/SingletonCookie"
dbus-run-session -- /opt/desktop/session.sh &
wait -n
