#!/bin/bash
# CI smoke test for the macOS build, on this runner's own architecture:
# are the bundled tools the app's own architecture, do they run, does the app launch and stay up.
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

# 1.6.3: each app carries tools of its own architecture (bin/mac/${arch}). The Apple Silicon app must not need Rosetta,
# which this runner has, so the check is the architecture itself (lipo), not whether the tools happen to run.
for a in "dist/mac/Grooveline Broadcaster.app:x86_64" "dist/mac-arm64/Grooveline Broadcaster.app:arm64"; do
  app=${a%:*}; want=${a##*:}
  [ -d "$app" ] || continue
  for t in ffmpeg sox; do
    got=$(lipo -archs "$app/Contents/Resources/$t" 2>/dev/null || echo missing)
    [ "$got" = "$want" ] || die "$app: $t is $got, must be $want only"
  done
done
# The install notes sit in each disk image's window (1.6.3).
NOTES=""
for d in dist/*.dmg; do
  mnt=$(mktemp -d); hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$d" >/dev/null || die "cannot open $d"
  [ -f "$mnt/Install Notes.txt" ] || { hdiutil detach "$mnt" >/dev/null; die "$d has no Install Notes.txt"; }
  hdiutil detach "$mnt" >/dev/null; NOTES="$NOTES $(basename "$d"): notes ok;"
done
NATIVE="tools: x64 app x86_64, arm64 app arm64"
if [ "$(uname -m)" = arm64 ]; then
  NATIVE="$NATIVE · native $(arch -arm64 "dist/mac-arm64/Grooveline Broadcaster.app/Contents/Resources/ffmpeg" -hide_banner -version 2>&1 | head -1 | cut -c1-40)"
fi

# The tools of this runner's own app: native on both runners, so they run with or without Rosetta.
if arch -x86_64 /usr/bin/true 2>/dev/null; then ROS="Rosetta present"; else ROS="no Rosetta"; fi
SOX=$("$APP/Contents/Resources/sox" --version 2>&1 | head -1)
FF=$("$APP/Contents/Resources/ffmpeg" -hide_banner -version 2>&1 | head -1)
echo "== $SYS | $ROS | $SOX | $FF"

LOG=$(mktemp)
"$APP/Contents/MacOS/Grooveline Broadcaster" >"$LOG" 2>&1 &
PID=$!
sleep 20
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"; wait "$PID" 2>/dev/null || true
  tail -20 "$LOG"
  note "$SYS | $ROS | sox: $SOX | ffmpeg: $FF | $NATIVE |$NOTES app ran 20 s OK | $DMGS"
else
  cat "$LOG"
  die "$SYS | app EXITED within 20 s | $ROS | $DMGS"
fi
