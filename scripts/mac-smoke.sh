#!/bin/bash
# CI smoke test for the macOS build, on this runner's own architecture:
# is Rosetta there, do the bundled x86_64 tools run, does the app launch and stay up.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -m)" = arm64 ]; then APP="dist/mac-arm64/Grooveline Broadcaster.app"; else APP="dist/mac/Grooveline Broadcaster.app"; fi
[ -d "$APP" ] || { echo "no app at $APP"; ls dist; exit 1; }
echo "== macOS $(sw_vers -productVersion) $(uname -m)"
# An unsigned build has a broken bundle seal; ad-hoc sign this copy so arm64 will run it (the dmgs are already made).
codesign -dv "$APP" 2>&1 | grep -q "Authority=Developer ID" || codesign --force --deep --sign - "$APP"

if arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo "== Rosetta: present"
  "$APP/Contents/Resources/sox" --version
  "$APP/Contents/Resources/ffmpeg" -hide_banner -version | head -1
else
  echo "== Rosetta: MISSING on this runner. The bundled x86_64 sox/ffmpeg can't run here (a DJ's fresh Apple Silicon Mac would hit the same)."
fi

LOG=$(mktemp)
"$APP/Contents/MacOS/Grooveline Broadcaster" >"$LOG" 2>&1 &
PID=$!
sleep 20
if kill -0 "$PID" 2>/dev/null; then
  echo "== app still running after 20 s: OK"
  kill "$PID"; wait "$PID" 2>/dev/null || true
  tail -20 "$LOG"
else
  echo "== app EXITED within 20 s"; cat "$LOG"; exit 1
fi
