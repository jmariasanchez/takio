#!/usr/bin/env bash
set -euo pipefail
fail() { echo "package-macos-release: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
mode=local
case "${1:-}" in
  '') [[ "$#" == 0 ]] || fail 'unexpected arguments' ;;
  --distribution) mode=distribution; shift; [[ "$#" == 0 ]] || fail 'unexpected arguments' ;;
  *) fail 'Usage: scripts/package-macos-release.sh [--distribution]' ;;
esac
# Explicit mode avoids touching accounts or discovering identities on local builds.
if [[ "$mode" == distribution ]]; then
  [[ "${APPLE_SIGNING_IDENTITY:-}" == 'Developer ID Application: '* ]] || fail 'distribution requires APPLE_SIGNING_IDENTITY (Developer ID Application)'
  if [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
    notary_args=(--keychain-profile "$APPLE_NOTARY_PROFILE")
  else
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] || fail 'distribution requires APPLE_NOTARY_PROFILE or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID'
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  fi
fi
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'native DMG packaging requires Apple Silicon macOS'
version=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
bash scripts/verify-release-version.sh "v$version"
bash scripts/package-desktop-native.sh
mkdir -p dist/releases
stage=$(mktemp -d "$PWD/dist/.native-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/image"
ditto dist/Takio.app "$stage/image/Takio.app"
app="$stage/image/Takio.app"
notarize() {
  local artifact="$1"
  local result="$stage/notary-result.json"
  xcrun notarytool submit "$artifact" "${notary_args[@]}" --wait --timeout 30m --output-format json > "$result"
  python3 - "$result" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
if result.get('status') != 'Accepted':
    sys.exit(f"Notarization not accepted: {result.get('status')} (submission {result.get('id')})")
print(f"Notarization accepted: {result.get('id')}")
PY
}
if [[ "$mode" == distribution ]]; then
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  ditto -c -k --keepParent "$app" "$stage/Takio.zip"
  notarize "$stage/Takio.zip"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  bash scripts/verify-macos-bundle.sh --distribution "$app"
else
  echo 'LOCAL AD-HOC BUILD: no Developer ID, notarization or Gatekeeper distribution approval. Do not publish.'
fi
ln -s /Applications "$stage/image/Applications"
name="Takio-$version-macos-arm64-$mode.dmg"
dmg="$stage/$name"
hdiutil create -volname Takio -srcfolder "$stage/image" -format UDZO "$dmg"
if [[ "$mode" == distribution ]]; then
  codesign --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
  notarize "$dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  bash scripts/verify-macos-dmg.sh --distribution "$dmg"
else
  bash scripts/verify-macos-dmg.sh "$dmg"
fi
# Only verified final bytes and their checksum enter the artifact directory.
mv -f "$dmg" "$dmg.sha256" dist/releases/
(cd dist/releases && shasum -a 256 --check "$name.sha256")
printf 'Native %s artifact: dist/releases/%s\n' "$mode" "$name"
