#!/usr/bin/env bash
set -Eeuo pipefail

export DISPLAY="${DISPLAY:-:99}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
export VNC_PORT="${VNC_PORT:-5900}"
export CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}"
export CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-/tmp/chrome-profile}"

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  kill "${CHROME_PID:-}" "${SERVER_PID:-}" "${XVFB_PID:-}" "${FLUXBOX_PID:-}" "${VNC_PID:-}" "${NOVNC_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT INT TERM

rm -rf "$CHROME_PROFILE_DIR"
mkdir -p "$CHROME_PROFILE_DIR"

Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

display_ready=false
for _ in $(seq 1 30); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    display_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$display_ready" != true ]]; then
  echo "Xvfb did not become ready." >&2
  exit 1
fi

fluxbox >/tmp/fluxbox.log 2>&1 &
FLUXBOX_PID=$!

VNC_ARGS=(
  -display "$DISPLAY"
  -rfbport "$VNC_PORT"
  -localhost
  -forever
  -shared
  -noxdamage
)
if [[ -n "${VNC_PASSWORD:-}" ]]; then
  VNC_ARGS+=( -passwd "${VNC_PASSWORD:0:8}" )
else
  VNC_ARGS+=( -nopw )
fi

x11vnc "${VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &
VNC_PID=$!

websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "127.0.0.1:$VNC_PORT" \
  >/tmp/websockify.log 2>&1 &
NOVNC_PID=$!

start_chrome() {
  rm -rf "$CHROME_PROFILE_DIR"
  mkdir -p "$CHROME_PROFILE_DIR"
  "$CHROME_BIN" \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --display="$DISPLAY" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-component-update \
    --disable-dev-shm-usage \
    --disable-features=Translate,MediaRouter \
    --disable-gpu \
    --no-sandbox \
    --window-size=1280,800 \
    about:blank \
    >/tmp/chrome.log 2>&1 &
  CHROME_PID=$!
}

start_chrome

node /app/server.js &
SERVER_PID=$!

while true; do
  if ! kill -0 "$CHROME_PID" 2>/dev/null || ! ps -o stat= -p "$CHROME_PID" | grep -qv 'Z'; then
    echo "Chrome exited; starting a clean browser profile." >&2
    wait "$CHROME_PID" 2>/dev/null || true
    start_chrome
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Web server exited; stopping container." >&2
    exit 1
  fi
  sleep 5
done
