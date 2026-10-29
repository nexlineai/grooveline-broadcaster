#!/bin/bash
# Sign, build, verify, notarize and staple both macOS dmgs (arm64 + x64).
# Shared by CI (release-mac.yml) and the USB-stick kit (mac-release.sh).
# Run with node_modules installed and bin/mac/{x64,arm64} filled (scripts/mac-deps.sh). Needs:
#   - a "Developer ID Application" identity: in $CSC_KEYCHAIN if set (CI), else the keychain search list
#   - a notarytool keychain profile $NOTARY_PROFILE (default grooveline-notary), stored in $CSC_KEYCHAIN if set
# Usage: scripts/mac-sign-notarize.sh <output dir>
# Never `grep -q` in a pipe here: under pipefail it can SIGPIPE the producer and fail a good run.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: mac-sign-notarize.sh <output dir>}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
PROFILE="${NOTARY_PROFILE:-grooveline-notary}"
KC="${CSC_KEYCHAIN:-}"
fail() { echo; echo "STOPPED: $1"; [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=mac release::$1"; exit 1; }
# Logs and artifacts need a token, annotations don't: on CI, also emit the first lines of a tool's output.
detail() { [ -n "${GITHUB_ACTIONS:-}" ] || return 0; printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | head -n "${2:-8}" | while IFS= read -r l; do echo "::error title=mac release detail::${l:0:900}"; done || true; }
step() { echo; echo "== $1"; }
unset CSC_LINK CSC_KEY_PASSWORD
# bash 3.2 (macOS) + set -u can't expand an empty array, so the keychain option is a plain word list.
kc() { [ -n "$KC" ] && printf -- '--keychain\n%s\n' "$KC"; return 0; }
NOTARY() { if [ -n "$KC" ]; then xcrun notarytool "$@" --keychain-profile "$PROFILE" --keychain "$KC"; else xcrun notarytool "$@" --keychain-profile "$PROFILE"; fi; }

step "Signing identity and notary login"
if [ -n "$KC" ]; then IDS=$(security find-identity -v -p codesigning "$KC" 2>&1 || true); else IDS=$(security find-identity -v -p codesigning 2>&1 || true); fi
IDENT=$(printf '%s\n' "$IDS" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
[ -n "$IDENT" ] || fail "no Developer ID Application identity in the keychain."
echo "  signing as: $IDENT"
NOTARY history >/dev/null 2>&1 || fail "notary login '$PROFILE' is missing, or its password is wrong."
echo "  notary login: OK"

step "Checking and signing the bundled sox and ffmpeg"
[ -z "${GITHUB_ACTIONS:-}" ] && echo "  If macOS asks to let codesign use your key: type your Mac password and click Always Allow."
# One set per app since 1.6.3: bin/mac/x64 (Intel app) and bin/mac/arm64 (Apple Silicon app, native).
for arch in x64 arm64; do
  want=$([ $arch = arm64 ] && echo arm64 || echo x86_64)
  for b in sox ffmpeg; do
    f="bin/mac/$arch/$b"
    [ -x "$f" ] || fail "$f is missing (run scripts/mac-deps.sh)."
    [ "$(lipo -archs "$f")" = "$want" ] || fail "$f is $(lipo -archs "$f"), not $want."
    bad=$(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)
    [ -z "$bad" ] || fail "$f needs libraries that aren't part of macOS ($bad)."
    # shellcheck disable=SC2046
    codesign --force --timestamp --options runtime --entitlements build/entitlements.mac.plist \
      --sign "$IDENT" $(kc) "$f" || fail "could not sign $f (keychain prompt denied?)."
    echo "  $arch/$b: $want, signed"
  done
done

step "Building and signing both dmgs (Apple Silicon + Intel)"
rm -rf dist/mac dist/mac-arm64 dist/*.dmg dist/*.blockmap
CSC_IDENTITY_AUTO_DISCOVERY=true CSC_NAME="${IDENT#Developer ID Application: }" \
  npx electron-builder --mac dmg --arm64 --x64 --publish never 2>&1 | tee "$OUT/build.log" \
  || { detail "$(tail -n 8 "$OUT/build.log")"; fail "the build failed."; }

step "Checking the signatures"
shopt -s nullglob
APPS=(dist/mac*/"Grooveline Broadcaster.app")
[ ${#APPS[@]} -eq 2 ] || fail "expected 2 built apps (arm64 + x64), found ${#APPS[@]}."
for app in "${APPS[@]}"; do
  v=$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1) || { echo "$v"; detail "$v"; fail "signature check failed: $app"; }
  for f in "$app" "$app/Contents/Resources/sox" "$app/Contents/Resources/ffmpeg"; do
    info=$(codesign -dvv "$f" 2>&1 || true)
    [[ $info == *"Authority=Developer ID Application"* ]] || fail "not signed with Developer ID: $f"
    [[ $info == *"(runtime)"* ]] || fail "hardened runtime missing: $f"
    ent=$(codesign -d --entitlements - "$f" 2>/dev/null || true)
    [[ $ent == *"device.audio-input"* ]] || fail "microphone entitlement missing: $f"
  done
  echo "  OK: $app"
done

step "Notarizing with Apple (often 5-15 minutes per dmg)"
DMGS=(dist/*.dmg)
[ ${#DMGS[@]} -eq 2 ] || fail "expected 2 dmgs, found ${#DMGS[@]}."
# Read a field from notarytool's JSON: whole file first, then line by line.
jget() { node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8"),k=process.argv[2];let v="";try{v=JSON.parse(t)[k]||""}catch(e){for(const l of t.split("\n")){try{const j=JSON.parse(l);if(j&&j[k])v=j[k]}catch(e){}}}console.log(v)' "$1" "$2"; }
native=x64; [ "$(uname -m)" = "arm64" ] && native=arm64
for dmg in "${DMGS[@]}"; do
  name=$(basename "$dmg")
  echo "  submitting $name"
  NOTARY submit "$dmg" --wait --output-format json > "$OUT/notary-$name.json" || true
  status=$(jget "$OUT/notary-$name.json" status); id=$(jget "$OUT/notary-$name.json" id)
  echo "  Apple says: ${status:-no answer} (id ${id:-none})"
  if [ "$status" != "Accepted" ]; then
    [ -n "$id" ] && { NOTARY log "$id" "$OUT/notary-log-$name.json" || true; }
    why=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const i of (j.issues||[]))console.log(`${i.severity}: ${i.path} [${i.architecture||"-"}]: ${i.message}`)}catch(e){console.log("no notary log")}' "$OUT/notary-log-$name.json")
    echo "$why"; detail "$why" 10
    fail "Apple did not accept $name ($status)."
  fi
  xcrun stapler staple "$dmg" || fail "stapling failed: $name"
  xcrun stapler validate "$dmg" || fail "staple check failed: $name"
  cp "$dmg" "$OUT/"   # notarized + stapled: saved before the Gatekeeper checks below
  out=$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true); echo "$out"
  [[ $out == *"Notarized Developer ID"* ]] || { detail "$out"; fail "Gatekeeper does not accept $name."; }
  # Assess the app inside only for this Mac's own architecture.
  if [[ "$name" == *"-mac-$native.dmg" ]]; then
    mnt=$(hdiutil attach -nobrowse -readonly "$dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
    out=$(spctl -a -t exec -vv "$mnt/Grooveline Broadcaster.app" 2>&1 || true); echo "$out"
    hdiutil detach "$mnt" -quiet || true
    [[ $out == *"Notarized Developer ID"* ]] || { detail "$out"; fail "Gatekeeper does not accept the app inside $name."; }
  else
    echo "  (app inside $name not assessed on this $(uname -m) Mac; the dmg itself passed)"
  fi
done
(cd "$OUT" && shasum -a 256 ./*.dmg > SHA256SUMS && cat SHA256SUMS)
echo
echo "SIGNED: both dmgs are notarized and stapled, in $OUT"
