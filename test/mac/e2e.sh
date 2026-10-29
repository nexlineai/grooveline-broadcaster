#!/bin/bash
# Mac e2e on a GitHub runner (29 Oct 2026): build this runner's app, give it a fake camera, BlackHole as the default
# input with a tone in it, and a local MediaMTX v1.4.0 (same version and timeouts as production: readTimeout 20 s
# since 29 Oct), then run freeze.mjs.
set -uo pipefail
cd "$(dirname "$0")/../.."
note() { echo "::notice title=$1::$2"; }
ARCH=$(uname -m); [ "$ARCH" = arm64 ] && { EB=--arm64; APP="dist/mac-arm64/Grooveline Broadcaster.app"; MTX=arm64; SUM=26bd1e8b29faf4677ba00afaeb395b02c67615e13983d5e2511318aae0e36a3b; } \
  || { EB=--x64; APP="dist/mac/Grooveline Broadcaster.app"; MTX=amd64; SUM=cf20e0f0d998e89c1176ea9a6888622ad72a30da06a3f2b61f9d26e003b3637b; }
W=$RUNNER_TEMP/e2e; mkdir -p "$W"
# VARIANT=baseline builds 1.6.1's src/ (the release on main), to show the test still catches the bug.
[ "${VARIANT:-fix}" = baseline ] && { git fetch -q --depth 1 origin 6fb675e0a06d5a2df2076d6e4440e2a8e9740fb3 && git checkout 6fb675e0a06d5a2df2076d6e4440e2a8e9740fb3 -- src/ || exit 1; }

CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir $EB --publish never >"$W/build.log" 2>&1 || { tail -30 "$W/build.log"; exit 1; }
codesign --force --deep --sign - "$APP"

brew install --cask blackhole-2ch >/dev/null 2>&1; brew install switchaudio-osx >/dev/null 2>&1
sudo killall coreaudiod; sleep 6
SwitchAudioSource -t input -s "BlackHole 2ch" >/dev/null
"$APP/Contents/Resources/sox" -q -n -t coreaudio "BlackHole 2ch" synth 900 sine 440 vol 0.3 >"$W/tone.log" 2>&1 &
TONE=$!; sleep 1
# Silence would stream just as well, so a dead tone must fail here (the app's own sox plays it: arm64 on arm64 since 1.6.3).
kill -0 $TONE 2>/dev/null || { echo "::error title=e2e::tone (bundled sox → BlackHole) exited: $(tr '\n' ' ' < "$W/tone.log" | cut -c1-300)"; exit 1; }

curl -fsSL -o "$W/mtx.tgz" "https://github.com/bluenviron/mediamtx/releases/download/v1.4.0/mediamtx_v1.4.0_darwin_$MTX.tar.gz"
echo "$SUM  $W/mtx.tgz" | shasum -a 256 -c >/dev/null || { echo "::error::mediamtx checksum mismatch"; exit 1; }
tar xzf "$W/mtx.tgz" -C "$W" mediamtx
printf 'logLevel: info\nreadTimeout: 20s\nwriteTimeout: 60s\napi: yes\napiAddress: 127.0.0.1:9997\nrtmp: yes\nrtmpAddress: :1935\nhls: no\nrtsp: no\nwebrtc: no\nsrt: no\npaths:\n  all_others:\n' > "$W/mediamtx.yml"
"$W/mediamtx" "$W/mediamtx.yml" >"$W/mediamtx.log" 2>&1 &
echo $! > "$W/mtx.pid"
export MTX_PID_FILE="$W/mtx.pid" MTX_BIN="$W/mediamtx" MTX_CONF="$W/mediamtx.yml" MTX_LOG="$W/mediamtx.log"
sleep 2

note input "${VARIANT:-fix} · default input: $(SwitchAudioSource -t input -c) · $(sw_vers -productVersion) $ARCH"
node test/mac/e2e/freeze.mjs "$APP/Contents/MacOS/Grooveline Broadcaster" "$W/out"; RC=$?
note mediamtx "$(grep -E 'is publishing|closed|timeout' "$W/mediamtx.log" | sed 's/^[0-9/ :]*//' | tail -6 | tr '\n' ' ' | cut -c1-900)"
exit $RC
