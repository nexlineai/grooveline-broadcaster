#!/bin/bash
# CI only (release-mac.yml): put the Developer ID certificate and the notary login into a throwaway
# keychain, and export CSC_KEYCHAIN for mac-sign-notarize.sh + electron-builder.
# Secrets come from the `mac-release` environment only:
#   MAC_CERT_P12_BASE64, MAC_CERT_P12_PASSWORD, APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD
# Deliberately not named CSC_LINK, so electron-builder never makes a second keychain of its own.
set -euo pipefail
: "${RUNNER_TEMP:?CI only}"
for v in MAC_CERT_P12_BASE64 MAC_CERT_P12_PASSWORD APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "::error title=mac release::secret $v is empty (environment mac-release)"; exit 1; }
done
KC="$RUNNER_TEMP/grooveline-signing.keychain-db"
KCPW=$(openssl rand -hex 24)
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 7200 "$KC"
security unlock-keychain -p "$KCPW" "$KC"

# Apple's Developer ID G2 intermediate, pinned (checked 21 Oct 2026, valid to Sep 2031).
curl -fsSL -o "$RUNNER_TEMP/DeveloperIDG2CA.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
echo "f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a  $RUNNER_TEMP/DeveloperIDG2CA.cer" | shasum -a 256 -c
security import "$RUNNER_TEMP/DeveloperIDG2CA.cer" -k "$KC"

P12="$RUNNER_TEMP/cert.p12"
printf '%s' "$MAC_CERT_P12_BASE64" | base64 --decode > "$P12"
security import "$P12" -k "$KC" -P "$MAC_CERT_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
rm -f "$P12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')

xcrun notarytool store-credentials grooveline-notary --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --keychain "$KC" >/dev/null
echo "CSC_KEYCHAIN=$KC" >> "$GITHUB_ENV"
ids=$(security find-identity -v -p codesigning "$KC" || true)
[[ $ids == *"Developer ID Application"* ]] || { echo "::error title=mac release::the .p12 has no Developer ID Application identity"; exit 1; }
echo "signing keychain ready"
