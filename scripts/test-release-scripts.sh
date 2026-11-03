#!/usr/bin/env bash
# Synthetic release orchestration tests. No builds, Apple access or publication.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-release-tests.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/scripts" "$root/tools"
cp "$repo/scripts/package-macos-release.sh" "$repo/scripts/verify-release-version.sh" "$root/scripts/"
printf '{"version":"0.1.0"}\n' > "$root/package.json"
cat > "$root/tools/cargo" <<'EOF'
#!/usr/bin/env bash
printf '{"packages":[{"name":"takio","version":"%s","manifest_path":"cli/Cargo.toml"},{"name":"takio-desktop","version":"%s","manifest_path":"native/Cargo.toml"}]}\n' "${CLI_VERSION:-0.1.0}" "${NATIVE_VERSION:-0.1.0}"
EOF
cat > "$root/tools/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi
EOF
cat > "$root/scripts/package-desktop-native.sh" <<'EOF'
set -eu
mkdir -p dist/Takio.app/Contents
printf native > dist/Takio.app/Contents/payload
EOF
cat > "$root/scripts/verify-macos-bundle.sh" <<'EOF'
set -eu
echo "bundle $*" >> "$TEST_LOG"
EOF
cat > "$root/scripts/verify-macos-dmg.sh" <<'EOF'
set -eu
echo "dmg $*" >> "$TEST_LOG"
[[ "${1:-}" != --distribution ]] || shift
(cd "$(dirname "$1")" && shasum -a 256 "$(basename "$1")" > "$(basename "$1").sha256")
EOF
cat > "$root/tools/fake-tool" <<'EOF'
#!/usr/bin/env bash
set -eu
tool=$(basename "$0")
echo "$tool $*" >> "$TEST_LOG"
case "$tool" in
  ditto)
    if [[ "$1" == -c ]]; then touch "${@: -1}"; else cp -R "$1" "$2"; fi ;;
  hdiutil) printf image > "${@: -1}" ;;
  codesign) [[ "${SIGNATURE_FAIL:-no}" != yes ]] ;;
  xcrun)
    if [[ "$1" == notarytool ]]; then
      printf '{"status":"%s","id":"test-submission"}\n' "${NOTARY_STATUS:-Accepted}"
    elif [[ "$1" == stapler ]]; then
      [[ "${STAPLE_FAIL:-no}" != yes ]]
    fi ;;
esac
EOF
chmod +x "$root/tools/"*
for tool in ditto hdiutil codesign xcrun; do ln -s fake-tool "$root/tools/$tool"; done
export PATH="$root/tools:$PATH" TEST_LOG="$root/log"
export APPLE_SIGNING_IDENTITY='' APPLE_NOTARY_PROFILE='' APPLE_ID='' APPLE_PASSWORD='' APPLE_TEAM_ID=''
reject() {
  local expected="$1" output
  shift
  if output=$("$@" 2>&1); then echo "Expected rejection: $expected" >&2; exit 1; fi
  [[ "$output" == *"$expected"* ]] || { echo "Wrong rejection: $output (expected $expected)" >&2; exit 1; }
}
version() { bash "$root/scripts/verify-release-version.sh" "$@"; }
package() { bash "$root/scripts/package-macos-release.sh" "$@"; }
version v0.1.0 >/dev/null
reject Usage version 0.1.0
reject Usage version v01.1.0
reject 'Release version mismatch' version v0.1.1
CLI_VERSION=0.2.0 reject 'cli/Cargo.toml' version v0.1.0
NATIVE_VERSION=0.2.0 reject 'native/Cargo.toml' version v0.1.0
reject Usage package --unknown
reject APPLE_SIGNING_IDENTITY package --distribution
APPLE_SIGNING_IDENTITY='Developer ID Application: Test' reject APPLE_NOTARY_PROFILE package --distribution
# Even available credentials do not opt a default run into Apple access.
export APPLE_SIGNING_IDENTITY='Developer ID Application: Test' APPLE_NOTARY_PROFILE=fixture
package > "$root/output"
[[ -f "$root/dist/releases/Takio-0.1.0-macos-arm64-local.dmg.sha256" ]]
if grep -q xcrun "$TEST_LOG"; then echo 'Local packaging contacted Apple tools' >&2; exit 1; fi
grep -q 'LOCAL AD-HOC BUILD' "$root/output"
package --distribution > "$root/output"
[[ -f "$root/dist/releases/Takio-0.1.0-macos-arm64-distribution.dmg.sha256" ]]
[[ "$(grep -c 'xcrun notarytool submit' "$TEST_LOG")" == 2 ]]
grep -q 'bundle --distribution' "$TEST_LOG"
grep -q 'dmg --distribution' "$TEST_LOG"
rm -f "$root/dist/releases/"*-distribution.dmg*
NOTARY_STATUS=Invalid reject 'Notarization not accepted' package --distribution
[[ ! -e "$root/dist/releases/Takio-0.1.0-macos-arm64-distribution.dmg" ]]
if SIGNATURE_FAIL=yes package --distribution > "$root/output" 2>&1; then echo 'Expected signing failure' >&2; exit 1; fi
if STAPLE_FAIL=yes package --distribution > "$root/output" 2>&1; then echo 'Expected stapling failure' >&2; exit 1; fi
[[ ! -e "$root/dist/releases/Takio-0.1.0-macos-arm64-distribution.dmg" ]]
echo 'release-script self-test: PASS (versions, explicit credentials, local/distribution routing, rejected notarization/signing/stapling)'
