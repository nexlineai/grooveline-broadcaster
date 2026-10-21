#!/bin/bash
# Fetch the pinned macOS ffmpeg + sox into bin/mac/ and verify their checksums.
# These exact files were checked on 21 Oct 2026: x86_64 (Rosetta on Apple Silicon),
# ffmpeg minos 10.12 / sox minos 10.10, and they link only /usr/lib and /System
# (which hardened runtime + notarization need). Never swap in a Homebrew sox: it links Homebrew dylibs.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=https://downloads.grooveline.org/build-deps/mac
mkdir -p bin/mac
fetch() { # <name> <sha256>
  if [ -f "bin/mac/$1" ] && echo "$2  bin/mac/$1" | shasum -a 256 -c --status; then echo "  ok $1 (already here)"; return; fi
  curl -fsSL --retry 3 -o "bin/mac/$1" "$BASE/$1-${2:0:12}"
  echo "$2  bin/mac/$1" | shasum -a 256 -c
  chmod +x "bin/mac/$1"
}
fetch ffmpeg 430d60fbf419dab28daee9b679e7929a31ee9bae53f6e42e8ae26b725584290f
fetch sox    f0a747b929bea1f01a0140d2e82b367f987f66e6dace759e3a972a6583ec8fa9
