#!/bin/bash
# Grooveline Broadcaster: signed + notarized Mac release. Runs on the Mac Air (macOS side),
# from the kit folder on a USB stick:   bash /Volumes/<STICK>/grooveline-mac-kit/mac-release.sh
#
# Claude Code can't run on Monterey, so this script checks everything up front and stops with a
# plain-English line. It unpacks the kit into ~/grooveline-mac-build (codesign breaks on exFAT),
# builds the arm64 + x64 dmgs, notarizes, staples and verifies them, then writes the dmgs, their
# checksums and the log back to the stick. It never pushes or uploads anything except to Apple's notary.
set -euo pipefail

PROFILE="grooveline-notary"
KIT="$(cd "$(dirname "$0")" && pwd)"
WORK="$HOME/grooveline-mac-build"
OUT="$KIT/out-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
LOG="$OUT/release.log"
exec > >(tee -a "$LOG") 2>&1

fail() { echo; echo "STOPPED: $1"; echo "Nothing was published. Reboot into Omarchy and give Claude the stick (log: $(basename "$OUT")/release.log)."; exit 1; }
step() { echo; echo "== $1"; }
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER

[ "$(uname -s)" = "Darwin" ] || fail "this script only runs on macOS."
echo "Grooveline Mac release, $(date) on macOS $(sw_vers -productVersion)"
[ -f "$KIT/KIT-INFO" ] && cat "$KIT/KIT-INFO"

step "1/7 Checking the Mac"
xcrun notarytool --version >/dev/null 2>&1 || fail "notarytool is missing. Run   xcode-select --install   and let it finish. If notarytool is still missing, install Xcode 14.2 from developer.apple.com/download/all, open it once, run   sudo xcode-select -s /Applications/Xcode.app   and then run this script again."
echo "  notarytool $(xcrun notarytool --version)"
command -v node >/dev/null || fail "Node.js is missing. Install the LTS .pkg from nodejs.org, then run this script again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || fail "Node.js $(node -v) is too old. Install the LTS .pkg from nodejs.org."
echo "  node $(node -v)"
FREE_GB=$(df -g "$HOME" | awk 'NR==2{print $4}')
[ "$FREE_GB" -ge 5 ] || fail "only ${FREE_GB} GB free on the Mac. The build needs about 5 GB."
IDENT=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)
[ -n "$IDENT" ] || fail "no Developer ID Application certificate in the keychain. Do checklist steps 3 and 4 (certificate request, then the certificate; double-click the .cer), then run this again."
TEAM=$(echo "$IDENT" | sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/')
echo "  signing as: $IDENT"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 || fail "the notary login isn't saved, or its password is wrong. Do checklist step 5: xcrun notarytool store-credentials $PROFILE --apple-id YOUR_APPLE_ACCOUNT_EMAIL --team-id $TEAM"
echo "  notary login: OK"

step "2/7 Unpacking the kit into $WORK"
(cd "$KIT" && shasum -a 256 -c SHA256SUMS) || fail "the kit on the stick is damaged (checksum mismatch)."
rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzf "$KIT/grooveline-mac-kit.tar.gz" -C "$WORK"
xattr -cr "$WORK"
cd "$WORK/broadcaster"
echo "  version $(node -p 'require("./package.json").version')"

step "3/7 Checking and signing the bundled sox and ffmpeg"
echo "  If macOS asks to let codesign use your key: type your Mac password and click Always Allow."
for b in sox ffmpeg; do
  [ -x "bin/mac/$b" ] || fail "bin/mac/$b is missing from the kit."
  bad=$(otool -L "bin/mac/$b" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/)' || true)
  [ -z "$bad" ] || fail "bin/mac/$b needs libraries that aren't part of macOS ($bad)."
  codesign --force --timestamp --options runtime --entitlements build/entitlements.mac.plist --sign "$IDENT" "bin/mac/$b" \
    || fail "could not sign $b (keychain prompt denied?)."
  echo "  $b: $(lipo -archs "bin/mac/$b"), signed"
done

step "4/7 Installing build tools (needs internet, a few minutes)"
npm ci --no-audit --no-fund || fail "npm ci failed (internet?)."

step "5/7 Building and signing both dmgs (Apple Silicon + Intel)"
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=true CSC_NAME="${IDENT#Developer ID Application: }" npx electron-builder --mac dmg --publish never \
  || fail "the build failed."

step "6/7 Checking the signatures"
shopt -s nullglob
APPS=(dist/mac*/"Grooveline Broadcaster.app")
[ ${#APPS[@]} -eq 2 ] || fail "expected 2 built apps (arm64 + x64), found ${#APPS[@]}."
for app in "${APPS[@]}"; do
  codesign --verify --deep --strict --verbose=2 "$app" || fail "signature check failed: $app"
  for f in "$app" "$app/Contents/Resources/sox" "$app/Contents/Resources/ffmpeg"; do
    info=$(codesign -dvv "$f" 2>&1)
    echo "$info" | grep -q "Authority=Developer ID Application" || fail "not signed with Developer ID: $f"
    echo "$info" | grep -q "(runtime)" || fail "hardened runtime missing: $f"
    ent=$(codesign -d --entitlements - "$f" 2>/dev/null || true)
    [[ $ent == *"device.audio-input"* ]] || fail "microphone entitlement missing: $f"
  done
  echo "  OK: $app"
done

step "7/7 Notarizing with Apple (often 5-15 minutes per dmg; leave it running)"
DMGS=(dist/*.dmg)
[ ${#DMGS[@]} -eq 2 ] || fail "expected 2 dmgs, found ${#DMGS[@]}."
# Read a field from notarytool's JSON: whole file first, then line by line.
jget() { node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8"),k=process.argv[2];let v="";try{v=JSON.parse(t)[k]||""}catch(e){for(const l of t.split("\n")){try{const j=JSON.parse(l);if(j&&j[k])v=j[k]}catch(e){}}}console.log(v)' "$1" "$2"; }
for dmg in "${DMGS[@]}"; do
  name=$(basename "$dmg")
  echo "  submitting $name"
  xcrun notarytool submit "$dmg" --keychain-profile "$PROFILE" --wait --output-format json > "$OUT/notary-$name.json" || true
  status=$(jget "$OUT/notary-$name.json" status); id=$(jget "$OUT/notary-$name.json" id)
  echo "  Apple says: ${status:-no answer} (id ${id:-none})"
  if [ "$status" != "Accepted" ]; then
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" "$OUT/notary-log-$name.json" || true
    fail "Apple did not accept $name. Apple's reasons are saved on the stick."
  fi
  xcrun stapler staple "$dmg" || fail "stapling failed: $name"
  xcrun stapler validate "$dmg" || fail "staple check failed: $name"
  cp "$dmg" "$OUT/"   # notarized + stapled: on the stick before the Gatekeeper checks below
  # Capture, then test: grep -q in a pipe can SIGPIPE spctl/tee and pipefail would fail a good run.
  out=$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true); echo "$out"
  [[ $out == *"Notarized Developer ID"* ]] || fail "Gatekeeper does not accept $name."
  # Assess the app inside only for this Mac's own architecture (the 2015 Air is Intel → x64).
  native=x64; [ "$(uname -m)" = "arm64" ] && native=arm64
  if [[ "$name" == *"-mac-$native.dmg" ]]; then
    mnt=$(hdiutil attach -nobrowse -readonly "$dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
    out=$(spctl -a -t exec -vv "$mnt/Grooveline Broadcaster.app" 2>&1 || true); echo "$out"
    hdiutil detach "$mnt" -quiet || true
    [[ $out == *"Notarized Developer ID"* ]] || fail "Gatekeeper does not accept the app inside $name."
  else
    echo "  (app inside $name not assessed on this $(uname -m) Mac; the dmg itself passed)"
  fi
done
(cd "$OUT" && shasum -a 256 *.dmg > SHA256SUMS && cat SHA256SUMS)

echo
echo "DONE. Both dmgs, their checksums and this log are on the stick in $(basename "$OUT")."
echo "Reboot into Omarchy, plug the stick in and tell Claude."
