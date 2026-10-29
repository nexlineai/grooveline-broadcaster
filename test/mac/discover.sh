#!/bin/bash
# Discovery on a GitHub Mac runner (29 Oct 2026): what can a Broadcaster e2e test use here, and does hiding the
# window stall the video like on Zé's Mac? Results are ::notice annotations (readable without a token).
set -uo pipefail
cd "$(dirname "$0")/../.."
note() { echo "::notice title=$1::$(echo "$2" | tr '\n' ' ' | cut -c1-900)"; }
SOX=bin/mac/sox
inputs() { system_profiler SPAudioDataType 2>/dev/null | grep -E "^ {8}[^ ].*:$|Input Channels" | sed 's/^ *//' | tr '\n' ' '; }

note system "macOS $(sw_vers -productVersion) $(uname -m) | $(sysctl -n machdep.cpu.brand_string) | $(sysctl -n hw.ncpu) cpu | rosetta: $(arch -x86_64 /usr/bin/true 2>/dev/null && echo yes || echo no) | audio before: $(inputs)"
brew install --cask blackhole-2ch >/tmp/bh.log 2>&1; RC=$?
sudo killall coreaudiod 2>/dev/null; sleep 6
note audio-after "blackhole install rc=$RC | $(inputs) | $(tail -2 /tmp/bh.log)"

# A tone into BlackHole, recorded back from it by sox (as the app records): is the signal there, or does TCC zero it?
"$SOX" -q -n -t coreaudio "BlackHole 2ch" synth 8 sine 440 vol 0.5 2>/tmp/play.err & sleep 2
"$SOX" -q -t coreaudio "BlackHole 2ch" /tmp/bh.wav trim 0 3 2>/tmp/rec.err; RC=$?
wait
note sox-blackhole "rc=$RC | $("$SOX" /tmp/bh.wav -n stat 2>&1 | grep -E 'Length|Maximum amplitude|RMS +amplitude' | tr -s ' ' | tr '\n' ';') | $(head -c 200 /tmp/rec.err) $(head -c 200 /tmp/play.err)"
"$SOX" -q -t coreaudio default /tmp/def.wav trim 0 2 2>/tmp/def.err; RC=$?
note sox-default "rc=$RC | $("$SOX" /tmp/def.wav -n stat 2>&1 | grep -E 'Maximum amplitude|RMS +amplitude' | tr -s ' ' | tr '\n' ';') | $(head -c 200 /tmp/def.err)"

E=node_modules/.bin/electron
run() { env "$@" "$E" test/mac/check 2>/dev/null | grep '^RESULT ' | tail -1 | cut -c8-; }
note throttle-rvfc "$(GL_LOOP=rvfc run)"
note throttle-timer "$(GL_LOOP=timer run)"
note throttle-direct "$(GL_LOOP=direct run)"
note throttle-rvfc-flags "$(GL_FLAGS=1 GL_LOOP=rvfc run)"
R=$(GL_MODE=enc GL_FFMPEG="$PWD/bin/mac/ffmpeg" run)
note h264-caps "$(echo "$R" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('chrome'), json.dumps(r.get('mediaRecorder')), json.dumps(r.get('videoEncoder')))" 2>&1)"
note h264-tests "$(echo "$R" | python3 -c "
import json,sys; r=json.load(sys.stdin)
print(' | '.join(f\"{t['name']} kbps={t.get('kbps')} keys={t.get('keyframes', t.get('chunkKeyframes'))} hw={t.get('hardwareAcceleration','')} err={t.get('error')}\" for t in r['tests']))" 2>&1)"
exit 0
