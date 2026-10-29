#!/bin/bash
# Mac e2e on a GitHub runner (29 Oct 2026): build this runner's app, give it a fake camera, BlackHole as the default
# input with a tone in it, and a local MediaMTX v1.4.0 (same version and timeouts as production), then run freeze.mjs.
set -uo pipefail
cd "$(dirname "$0")/../.."
note() { echo "::notice title=$1::$2"; }
ARCH=$(uname -m); [ "$ARCH" = arm64 ] && { EB=--arm64; APP="dist/mac-arm64/Grooveline Broadcaster.app"; MTX=arm64; SUM=26bd1e8b29faf4677ba00afaeb395b02c67615e13983d5e2511318aae0e36a3b; } \
  || { EB=--x64; APP="dist/mac/Grooveline Broadcaster.app"; MTX=amd64; SUM=cf20e0f0d998e89c1176ea9a6888622ad72a30da06a3f2b61f9d26e003b3637b; }
W=$RUNNER_TEMP/e2e; mkdir -p "$W"

CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir $EB --publish never >"$W/build.log" 2>&1 || { tail -30 "$W/build.log"; exit 1; }
codesign --force --deep --sign - "$APP"

brew install --cask blackhole-2ch >/dev/null 2>&1; brew install switchaudio-osx >/dev/null 2>&1
sudo killall coreaudiod; sleep 6
SwitchAudioSource -t input -s "BlackHole 2ch" >/dev/null
bin/mac/sox -q -n -t coreaudio "BlackHole 2ch" synth 900 sine 440 vol 0.3 >/dev/null 2>&1 &

curl -fsSL -o "$W/mtx.tgz" "https://github.com/bluenviron/mediamtx/releases/download/v1.4.0/mediamtx_v1.4.0_darwin_$MTX.tar.gz"
echo "$SUM  $W/mtx.tgz" | shasum -a 256 -c >/dev/null || { echo "::error::mediamtx checksum mismatch"; exit 1; }
tar xzf "$W/mtx.tgz" -C "$W" mediamtx
printf 'logLevel: info\nreadTimeout: 60s\nwriteTimeout: 60s\napi: yes\napiAddress: 127.0.0.1:9997\nrtmp: yes\nrtmpAddress: :1935\nhls: no\nrtsp: no\nwebrtc: no\nsrt: no\npaths:\n  all_others:\n' > "$W/mediamtx.yml"
"$W/mediamtx" "$W/mediamtx.yml" >"$W/mediamtx.log" 2>&1 &
sleep 2

npm i --no-save --no-audit --no-fund --prefix test/mac/e2e playwright-core@1.63.0 >/dev/null 2>&1
note input "default input: $(SwitchAudioSource -t input -c) · $(sw_vers -productVersion) $ARCH"
node test/mac/e2e/freeze.mjs "$APP/Contents/MacOS/Grooveline Broadcaster" "$W/out"; RC=$?
note mediamtx "$(grep -E 'is publishing|closed|timeout' "$W/mediamtx.log" | sed 's/^[0-9/ :]*//' | tail -6 | tr '\n' ' ' | cut -c1-900)"
exit $RC
