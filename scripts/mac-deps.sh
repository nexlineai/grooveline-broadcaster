#!/bin/bash
# Fetch the pinned macOS ffmpeg + sox into bin/mac/<arch>/ and verify their checksums. electron-builder copies
# bin/mac/${arch}/ into each app (package.json), so the Intel app gets x86_64 tools and the Apple Silicon app native
# ones (1.6.3): the x86_64 tools needed Rosetta, and a Mac without it could not stream.
# x64, checked 21 Oct 2026: evermeet ffmpeg (minos 10.12) and sox (minos 10.10).
# arm64, checked 29 Oct 2026: Martin Riedl's static ffmpeg 9.0.2 release (minos 12.0) and sox 14.4.2 built from the
# official tarball with only CoreAudio + raw (scripts/mac-tools-arm64.sh, minos 11.0).
# All link only /usr/lib and /System (which hardened runtime + notarization need). Never swap in a Homebrew sox: it
# links Homebrew dylibs.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=https://downloads.grooveline.org/build-deps/mac
fetch() { # <arch> <name> <path under BASE> <sha256>
  local f="bin/mac/$1/$2"; mkdir -p "bin/mac/$1"
  if [ -f "$f" ] && echo "$4  $f" | shasum -a 256 -c --status; then echo "  ok $1/$2 (already here)"; return; fi
  curl -fsSL --retry 3 -o "$f" "$BASE/$3"
  echo "$4  $f" | shasum -a 256 -c
  chmod +x "$f"
}
fetch x64   ffmpeg ffmpeg-430d60fbf419       430d60fbf419dab28daee9b679e7929a31ee9bae53f6e42e8ae26b725584290f
fetch x64   sox    sox-f0a747b929be          f0a747b929bea1f01a0140d2e82b367f987f66e6dace759e3a972a6583ec8fa9
fetch arm64 ffmpeg arm64/ffmpeg-2e11c6f90993 2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384
fetch arm64 sox    arm64/sox-69885f2f7868    69885f2f78684cbe6bcfe8777e3be62a3011b58a4f4f2639b8ea29e6e1610ea2
