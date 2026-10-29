#!/bin/bash
# Native Apple Silicon ffmpeg + sox for the arm64 app (29 Oct 2026), on an arm64 runner.
# The bundled tools are x86_64 only, so a Mac without Rosetta can't stream (Apple is phasing Rosetta out after macOS 27).
# ffmpeg: Martin Riedl's static release build 9.0.2 (pinned, checksummed). sox 14.4.2: built here from the official
# tarball with only the CoreAudio driver and raw output, no extra libraries. Same rule as mac-deps.sh: link only
# /usr/lib and /System. Writes out/{ffmpeg,sox,SHA256SUMS} and ::notice lines.
set -euo pipefail
cd "$(dirname "$0")/.."
note() { echo "::notice title=$1::$(echo "$2" | tr '\n' ' ' | cut -c1-900)"; }
die() { echo "::error title=arm64 tools::$*"; exit 1; }
[ "$(uname -m)" = arm64 ] || die "needs an arm64 runner"
W=$RUNNER_TEMP/arm64-tools; OUT=$W/out; rm -rf "$W"; mkdir -p "$OUT"

curl -fsSL -o "$W/ffmpeg.zip" https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
echo "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924  $W/ffmpeg.zip" | shasum -a 256 -c >/dev/null || die "ffmpeg checksum"
unzip -q -o "$W/ffmpeg.zip" -d "$OUT"; chmod +x "$OUT/ffmpeg"

curl -fsSL -o "$W/sox.tar.bz2" https://downloads.sourceforge.net/project/sox/sox/14.4.2/sox-14.4.2.tar.bz2
echo "81a6956d4330e75b5827316e44ae381e6f1e8928003c6aa45896da9041ea149c  $W/sox.tar.bz2" | shasum -a 256 -c >/dev/null || die "sox checksum"
tar xjf "$W/sox.tar.bz2" -C "$W"
( cd "$W/sox-14.4.2"
  # Old C that today's clang rejects by default; MACOSX_DEPLOYMENT_TARGET 11.0 = the first macOS on Apple Silicon.
  export MACOSX_DEPLOYMENT_TARGET=11.0 CFLAGS="-O2 -Wno-error=implicit-function-declaration -Wno-error=implicit-int -Wno-error=int-conversion -Wno-error=incompatible-function-pointer-types"
  ./configure -q --disable-shared --enable-static --disable-openmp --with-coreaudio \
    --without-magic --without-png --without-ladspa --without-mad --without-id3tag --without-lame --without-twolame \
    --without-oggvorbis --without-opus --without-flac --without-amrwb --without-amrnb --without-wavpack \
    --without-sndfile --without-mp3 --without-gsm --without-lpc10 --without-ao --without-pulseaudio --without-alsa \
    --without-oss --without-sndio --without-waveaudio --without-sunaudio >"$W/sox-configure.log" 2>&1 || { tail -20 "$W/sox-configure.log"; die "sox configure"; }
  make -s -j3 >"$W/sox-make.log" 2>&1 || { tail -30 "$W/sox-make.log"; die "sox make"; }
  cp src/sox "$OUT/sox" ) 
strip "$OUT/sox" || true

for t in ffmpeg sox; do
  f=$OUT/$t
  archs=$(lipo -archs "$f"); [ "$archs" = arm64 ] || die "$t is $archs, not arm64"
  libs=$(otool -L "$f" | tail -n +2 | awk '{print $1}')
  bad=$(echo "$libs" | grep -v -E '^(/usr/lib/|/System/)' || true)
  [ -z "$bad" ] || die "$t links outside the system: $bad"
  minos=$(otool -l "$f" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')
  note "$t" "arm64 only · minos $minos · $(echo "$libs" | wc -l | tr -d ' ') system libraries · $(shasum -a 256 "$f" | cut -c1-64)"
done

# What the app needs from ffmpeg (encoders, muxers, demuxers, protocols, devices, filters).
miss=""
for e in libx264 aac libvorbis; do "$OUT/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q " $e " || miss="$miss enc:$e"; done
for m in flv tee matroska mp4 ogg adts; do "$OUT/ffmpeg" -hide_banner -muxers 2>/dev/null | grep -q " $m " || miss="$miss mux:$m"; done
for d in matroska,webm s16le f32le; do "$OUT/ffmpeg" -hide_banner -demuxers 2>/dev/null | grep -q " $d " || miss="$miss demux:$d"; done
"$OUT/ffmpeg" -hide_banner -protocols 2>/dev/null | grep -q -w rtmp || miss="$miss proto:rtmp"
"$OUT/ffmpeg" -hide_banner -protocols 2>/dev/null | grep -q -w icecast || miss="$miss proto:icecast"
"$OUT/ffmpeg" -hide_banner -devices 2>/dev/null | grep -q avfoundation || miss="$miss dev:avfoundation"
for fl in pan volume aresample volumedetect; do "$OUT/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q " $fl " || miss="$miss filter:$fl"; done
note ffmpeg-features "${miss:-everything the app uses is there} · $("$OUT/ffmpeg" -hide_banner -version | head -1)"

# sox really records from CoreAudio (BlackHole, with a tone played into it by this same sox).
brew install --cask blackhole-2ch >/dev/null 2>&1; sudo killall coreaudiod; sleep 6
"$OUT/sox" -q -n -t coreaudio "BlackHole 2ch" synth 6 sine 440 vol 0.5 & sleep 2
"$OUT/sox" -q -t coreaudio "BlackHole 2ch" -t raw -r 44100 -e signed -b 16 -c 2 "$W/rec.raw" trim 0 2 || die "sox could not record from CoreAudio"
wait
"$OUT/ffmpeg" -hide_banner -f s16le -ar 44100 -ac 2 -i "$W/rec.raw" -af volumedetect -f null - 2>&1 | grep -E "max_volume" | sed 's/.*\] //' > "$W/vol.txt"
note sox-coreaudio "$("$OUT/sox" --version 2>&1 | head -1) · recorded $(stat -f%z "$W/rec.raw") bytes from BlackHole · $(cat "$W/vol.txt")"
(cd "$OUT" && shasum -a 256 ffmpeg sox > SHA256SUMS)
