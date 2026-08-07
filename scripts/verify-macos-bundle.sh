#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "verify-macos-bundle: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-bundle.sh [--distribution] <path-to-app>

Verifies a built macOS application bundle. Distribution mode additionally
requires a signing team, hardened runtime, and a successful Gatekeeper check.

For focused tests, tool paths may be overridden with:
  TAKIO_PLUTIL_COMMAND, TAKIO_LIPO_COMMAND, TAKIO_OTOOL_COMMAND,
  TAKIO_CODESIGN_COMMAND, and TAKIO_SPCTL_COMMAND.
EOF
}

distribution=false
if [[ "${1:-}" == "--distribution" ]]; then
  distribution=true
  shift
fi

if [[ "$#" -ne 1 ]]; then
  usage >&2
  fail "expected exactly one explicit .app path"
fi

bundle_path="$1"
case "$bundle_path" in
  -*) fail "target path must not begin with '-': $bundle_path" ;;
  *.app) ;;
  *) fail "target must have a .app suffix: $bundle_path" ;;
esac
[[ -d "$bundle_path" ]] || fail "application bundle does not exist: $bundle_path"

plutil_command="${TAKIO_PLUTIL_COMMAND:-/usr/bin/plutil}"
lipo_command="${TAKIO_LIPO_COMMAND:-/usr/bin/lipo}"
otool_command="${TAKIO_OTOOL_COMMAND:-/usr/bin/otool}"
codesign_command="${TAKIO_CODESIGN_COMMAND:-/usr/bin/codesign}"
spctl_command="${TAKIO_SPCTL_COMMAND:-/usr/sbin/spctl}"

require_tool() {
  local tool_path="$1"
  local tool_name="$2"
  [[ -x "$tool_path" ]] || fail "$tool_name is unavailable or not executable: $tool_path"
}

require_tool "$plutil_command" "plutil"
require_tool "$lipo_command" "lipo"
require_tool "$otool_command" "otool"
require_tool "$codesign_command" "codesign"
if [[ "$distribution" == true ]]; then
  require_tool "$spctl_command" "spctl"
fi

info_plist="$bundle_path/Contents/Info.plist"
[[ -f "$info_plist" ]] || fail "missing Info.plist: $info_plist"

if ! executable_name="$("$plutil_command" -extract CFBundleExecutable raw -o - "$info_plist")"; then
  fail "could not read CFBundleExecutable from $info_plist"
fi
[[ -n "$executable_name" ]] || fail "CFBundleExecutable is empty in $info_plist"
case "$executable_name" in
  .|..|*/*) fail "CFBundleExecutable must be a file name, got: $executable_name" ;;
esac

main_executable="$bundle_path/Contents/MacOS/$executable_name"
sidecar_executable="$bundle_path/Contents/MacOS/takio-library-engine"

if ! bundle_minimum_version="$("$plutil_command" -extract LSMinimumSystemVersion raw -o - "$info_plist")"; then
  fail "could not read LSMinimumSystemVersion from $info_plist"
fi
if [[ ! "$bundle_minimum_version" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
  fail "invalid LSMinimumSystemVersion in $info_plist: $bundle_minimum_version"
fi

for executable in "$main_executable" "$sidecar_executable"; do
  [[ -f "$executable" ]] || fail "missing bundled executable: $executable"
  [[ -x "$executable" ]] || fail "bundled executable is not executable: $executable"
done

read_minimum_system_version() {
  local executable="$1"
  local output
  local version

  if ! output="$("$otool_command" -l "$executable")"; then
    fail "could not inspect minimum system version for $executable"
  fi
  version="$(awk '
    $1 == "cmd" { command = $2 }
    command == "LC_BUILD_VERSION" && $1 == "minos" { print $2; exit }
    command == "LC_VERSION_MIN_MACOSX" && $1 == "version" { print $2; exit }
  ' <<< "$output")"
  if [[ ! "$version" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
    fail "no valid minimum system version reported for $executable"
  fi
  printf '%s\n' "$version"
}

version_is_newer() {
  awk -v required="$1" -v configured="$2" 'BEGIN {
    split(required, required_parts, ".")
    split(configured, configured_parts, ".")
    for (part = 1; part <= 3; part++) {
      if ((required_parts[part] + 0) > (configured_parts[part] + 0)) exit 0
      if ((required_parts[part] + 0) < (configured_parts[part] + 0)) exit 1
    }
    exit 1
  }'
}

for executable in "$main_executable" "$sidecar_executable"; do
  executable_minimum_version="$(read_minimum_system_version "$executable")"
  if version_is_newer "$executable_minimum_version" "$bundle_minimum_version"; then
    fail "$executable requires macOS $executable_minimum_version but the bundle declares $bundle_minimum_version"
  fi
done

read_architectures() {
  local executable="$1"
  local output
  if ! output="$("$lipo_command" -archs "$executable")"; then
    fail "could not inspect architectures for $executable"
  fi
  [[ -n "$output" ]] || fail "no architectures reported for $executable"
  printf '%s\n' "$output" | tr '[:space:]' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

main_architectures="$(read_architectures "$main_executable")"
sidecar_architectures="$(read_architectures "$sidecar_executable")"
if [[ "$main_architectures" != "$sidecar_architectures" ]]; then
  fail "architecture mismatch: $executable_name has [$main_architectures], takio-library-engine has [$sidecar_architectures]"
fi

verify_dependencies() {
  local executable="$1"
  local output
  local line_number=0
  local dependency
  local trimmed

  if ! output="$("$otool_command" -L "$executable")"; then
    fail "could not inspect dynamic-library dependencies for $executable"
  fi

  while IFS= read -r line; do
    line_number=$((line_number + 1))
    [[ "$line_number" -eq 1 ]] && continue
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" ]] && continue
    dependency="${trimmed%% (compatibility version*}"

    case "$dependency" in
      /System/Library/*|/usr/lib/*|@rpath/*|@loader_path/*|@executable_path/*) ;;
      /*) fail "non-system absolute dependency in $executable: $dependency" ;;
      *) fail "unexpected dependency reference in $executable: $dependency" ;;
    esac
  done <<< "$output"
}

verify_dependencies "$main_executable"
verify_dependencies "$sidecar_executable"

if ! "$codesign_command" --verify --deep --strict --verbose=2 "$bundle_path"; then
  fail "strict deep code-signature verification failed: $bundle_path"
fi

distribution_team() {
  local target="$1"
  local label="$2"
  local details
  local line
  local team_identifier=""
  local hardened_runtime=false

  if ! details="$("$codesign_command" -dv --verbose=4 "$target" 2>&1)"; then
    fail "could not inspect distribution signature for $label: $target"
  fi

  while IFS= read -r line; do
    case "$line" in
      TeamIdentifier=*) team_identifier="${line#TeamIdentifier=}" ;;
      *flags=*runtime*) hardened_runtime=true ;;
    esac
  done <<< "$details"

  if [[ -z "$team_identifier" || "$team_identifier" == "not set" ]]; then
    fail "$label has no signing TeamIdentifier: $target"
  fi
  if [[ "$hardened_runtime" != true ]]; then
    fail "$label is not signed with the hardened runtime: $target"
  fi

  printf '%s\n' "$team_identifier"
}

if [[ "$distribution" == true ]]; then
  if ! app_team="$(distribution_team "$bundle_path" "application bundle")"; then
    exit 1
  fi
  if ! sidecar_team="$(distribution_team "$sidecar_executable" "sidecar executable")"; then
    exit 1
  fi
  if [[ "$app_team" != "$sidecar_team" ]]; then
    fail "signing-team mismatch: application uses $app_team, sidecar uses $sidecar_team"
  fi
  if ! "$spctl_command" --assess --type execute --verbose=4 "$bundle_path"; then
    fail "Gatekeeper assessment failed: $bundle_path"
  fi
fi

mode="local"
[[ "$distribution" == true ]] && mode="distribution"
echo "Verified macOS bundle: $bundle_path (architectures: $main_architectures; mode: $mode)"
