#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "verify-macos-dmg: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-dmg.sh <path-to-dmg> [expected-app-name]

Verifies a built macOS DMG deterministically without Finder or signing secrets:
  - hdiutil imageinfo reports a compressed read-only UDIF image
  - hdiutil verify succeeds
  - the image attaches read-only without browsing or auto-opening
  - the mounted volume contains the expected .app and an /Applications symlink
  - the .app inside the DMG passes scripts/verify-macos-bundle.sh
  - a SHA-256 sidecar is written next to the DMG
EOF
}

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  usage >&2
  fail "expected a DMG path and optional expected app name"
fi

dmg_path="$1"
expected_app_name="${2:-Takio.app}"
case "$dmg_path" in
  -*) fail "DMG path must not begin with '-': $dmg_path" ;;
  *.dmg) ;;
  *) fail "target must have a .dmg suffix: $dmg_path" ;;
esac
case "$expected_app_name" in
  -*) fail "expected app name must not begin with '-': $expected_app_name" ;;
  *.app) ;;
  *) fail "expected app name must have a .app suffix: $expected_app_name" ;;
esac
[[ -f "$dmg_path" ]] || fail "DMG does not exist: $dmg_path"

hdiutil_command="${TAKIO_HDIUTIL_COMMAND:-/usr/bin/hdiutil}"
shasum_command="${TAKIO_SHASUM_COMMAND:-/usr/bin/shasum}"
[[ -x "$hdiutil_command" ]] || fail "hdiutil is unavailable or not executable: $hdiutil_command"
[[ -x "$shasum_command" ]] || fail "shasum is unavailable or not executable: $shasum_command"

if ! imageinfo="$($hdiutil_command imageinfo "$dmg_path")"; then
  fail "hdiutil imageinfo failed: $dmg_path"
fi
case "$imageinfo" in
  *$'Format: UDZO'*|*$'Format: UDBZ'*|*$'Format: ULFO'*|*$'Format: ULMO'*) ;;
  *) fail "DMG is not a compressed read-only UDIF image: $dmg_path" ;;
esac
case "$imageinfo" in
  *$'Checksum Type: none'*) fail "DMG has no embedded checksum: $dmg_path" ;;
esac

if ! "$hdiutil_command" verify "$dmg_path"; then
  fail "hdiutil verify failed: $dmg_path"
fi

mount_root="$(mktemp -d "${TMPDIR:-/tmp}/takio-dmg-verify.XXXXXX")"
mount_point=""
declare -a devices=()
cleanup() {
  local device
  for device in "${devices[@]:-}"; do
    "$hdiutil_command" detach "$device" >/dev/null 2>&1 || true
  done
  [[ -z "$mount_point" || ! -d "$mount_point" ]] || rmdir "$mount_point" >/dev/null 2>&1 || true
  rmdir "$mount_root" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mount_point="$mount_root/volume"
mkdir "$mount_point"
if ! attach_output="$($hdiutil_command attach -readonly -noverify -noautoopen -nobrowse -mountpoint "$mount_point" "$dmg_path")"; then
  fail "could not attach DMG read-only: $dmg_path"
fi
while IFS= read -r line; do
  [[ "$line" == /dev/* ]] || continue
  set -- $line
  devices+=("$1")
done <<< "$attach_output"
[[ "${#devices[@]}" -gt 0 ]] || fail "hdiutil attach did not report a device for $dmg_path"

app_path="$mount_point/$expected_app_name"
[[ -d "$app_path" ]] || fail "DMG is missing expected app: $expected_app_name"
[[ -L "$mount_point/Applications" ]] || fail "DMG is missing Applications symlink"
applications_target="$(readlink "$mount_point/Applications")"
[[ "$applications_target" == "/Applications" ]] || fail "Applications symlink points to $applications_target, expected /Applications"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-macos-bundle.sh" "$app_path"

(
  cd "$(dirname "$dmg_path")"
  "$shasum_command" -a 256 "$(basename "$dmg_path")" > "$(basename "$dmg_path").sha256"
)

echo "Verified macOS DMG: $dmg_path"
echo "Wrote checksum: $dmg_path.sha256"
