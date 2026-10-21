#!/bin/bash
# CI smoke test for the macOS build, on this runner's own architecture:
# is Rosetta there, do the bundled x86_64 tools run, does the app launch and stay up.
# The result is also written as a ::notice annotation, which is readable without a token on a public repo.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -m)" = arm64 ]; then APP="dist/mac-arm64/Grooveline Broadcaster.app"; else APP="dist/mac/Grooveline Broadcaster.app"; fi
note() { echo "::notice title=mac smoke::$*"; }
die() { echo "::error title=mac smoke::$*"; exit 1; }
[ -d "$APP" ] || die "no app at $APP ($(ls dist | tr '\n' ' '))"
SYS="macOS $(sw_vers -productVersion) $(uname -m)"
DMGS=$(cd dist && for f in *.dmg; do printf '%s (%s MB) ' "$f" $(( $(stat -f%z "$f") / 1048576 )); done)
# An unsigned build has a broken bundle seal; ad-hoc sign this copy so arm64 will run it (the dmgs are already made).
codesign -dv "$APP" 2>&1 | grep -q "Authority=Developer ID" || codesign --force --deep --sign - "$APP"

if arch -x86_64 /usr/bin/true 2>/dev/null; then
  ROS="Rosetta present"
  SOX=$("$APP/Contents/Resources/sox" --version 2>&1 | head -1)
  FF=$("$APP/Contents/Resources/ffmpeg" -hide_banner -version 2>&1 | head -1)
else
  ROS="Rosetta MISSING (bundled x86_64 sox/ffmpeg can't run; a fresh Apple Silicon Mac would hit the same)"
  SOX="-"; FF="-"
fi
echo "== $SYS | $ROS | $SOX | $FF"

LOG=$(mktemp)
"$APP/Contents/MacOS/Grooveline Broadcaster" >"$LOG" 2>&1 &
PID=$!
sleep 20
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"; wait "$PID" 2>/dev/null || true
  tail -20 "$LOG"
  note "$SYS | $ROS | sox: $SOX | ffmpeg: $FF | app ran 20 s OK | $DMGS"
else
  cat "$LOG"
  die "$SYS | app EXITED within 20 s | $ROS | $DMGS"
fi
