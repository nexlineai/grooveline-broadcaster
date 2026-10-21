#!/bin/bash
# FALLBACK ONLY (the normal route is release-mac.yml in GitHub Actions).
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

step "1/4 Checking the Mac"
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

step "2/4 Unpacking the kit into $WORK"
(cd "$KIT" && shasum -a 256 -c SHA256SUMS) || fail "the kit on the stick is damaged (checksum mismatch)."
rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzf "$KIT/grooveline-mac-kit.tar.gz" -C "$WORK"
xattr -cr "$WORK"
cd "$WORK/broadcaster"
echo "  version $(node -p 'require("./package.json").version')"

step "3/4 Installing build tools (needs internet, a few minutes)"
npm ci --no-audit --no-fund || fail "npm ci failed (internet?)."

step "4/4 Signing, building, notarizing (about 30 minutes, mostly waiting for Apple)"
NOTARY_PROFILE="$PROFILE" bash scripts/mac-sign-notarize.sh "$OUT" || fail "see the STOPPED line above."

echo
echo "DONE. Both dmgs, their checksums and this log are on the stick in $(basename "$OUT")."
echo "Reboot into Omarchy, plug the stick in and tell Claude."
