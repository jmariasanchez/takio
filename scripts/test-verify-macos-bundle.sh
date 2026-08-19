#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
verifier="$repo_root/scripts/verify-macos-bundle.sh"
test_parent="${TMPDIR:-/tmp}"
test_parent="${test_parent%/}"
test_root="$(mktemp -d "$test_parent/takio-bundle-verifier-test.XXXXXX")"

cleanup() {
  case "$test_root" in
    "$test_parent"/takio-bundle-verifier-test.*)
      rm -rf -- "$test_root"
      ;;
    *)
      echo "Refusing to clean unexpected test path: $test_root" >&2
      ;;
  esac
}
trap cleanup EXIT

tool_dir="$test_root/tools"
bundle_path="$test_root/Fixture Bundle.app"
mkdir -p "$tool_dir" "$bundle_path/Contents/MacOS" "$bundle_path/Contents/Resources/bin"
touch "$bundle_path/Contents/Info.plist"
touch "$bundle_path/Contents/MacOS/takio"
touch "$bundle_path/Contents/Resources/bin/takio-library-engine"
chmod +x "$bundle_path/Contents/MacOS/takio"
chmod +x "$bundle_path/Contents/Resources/bin/takio-library-engine"

cat > "$tool_dir/fake-tool" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

tool_name="$(basename "$0")"
target=""
for argument in "$@"; do
  target="$argument"
done

is_sidecar=false
case "$target" in
  *takio-library-engine) is_sidecar=true ;;
esac

case "$tool_name" in
  plutil)
    if [[ " $* " == *" LSMinimumSystemVersion "* ]]; then
      printf '%s\n' "${FAKE_PLIST_MINIMUM_VERSION:-13.0}"
    else
      printf '%s\n' "${FAKE_PLIST_EXECUTABLE:-takio}"
    fi
    ;;
  lipo)
    if [[ "$is_sidecar" == true ]]; then
      printf '%s\n' "${FAKE_SIDECAR_ARCHS:-arm64}"
    else
      printf '%s\n' "${FAKE_MAIN_ARCHS:-arm64}"
    fi
    ;;
  otool)
    if [[ " $* " == *" -l "* ]]; then
      if [[ "$is_sidecar" == true ]]; then
        minimum_version="${FAKE_SIDECAR_MINIMUM_VERSION:-13.0}"
      else
        minimum_version="${FAKE_MAIN_MINIMUM_VERSION:-13.0}"
      fi
      printf 'Load command 0\n'
      printf '      cmd LC_BUILD_VERSION\n'
      printf '    minos %s\n' "$minimum_version"
      exit
    fi
    printf '%s:\n' "$target"
    if [[ "$is_sidecar" == true ]]; then
      dependencies="${FAKE_SIDECAR_DEPENDENCIES:-/usr/lib/libSystem.B.dylib}"
    else
      dependencies="${FAKE_MAIN_DEPENDENCIES:-/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit}"
    fi
    while IFS= read -r dependency; do
      [[ -z "$dependency" ]] && continue
      printf '\t%s (compatibility version 1.0.0, current version 1.0.0)\n' "$dependency"
    done <<< "$dependencies"
    ;;
  codesign)
    if [[ " $* " == *" --verify "* ]]; then
      [[ "${FAKE_CODESIGN_VERIFY:-pass}" == pass ]]
      exit
    fi
    if [[ "$is_sidecar" == true ]]; then
      team="${FAKE_SIDECAR_TEAM-ABCDE12345}"
      runtime="${FAKE_SIDECAR_RUNTIME:-yes}"
    else
      team="${FAKE_APP_TEAM-ABCDE12345}"
      runtime="${FAKE_APP_RUNTIME:-yes}"
    fi
    if [[ -n "$team" ]]; then
      printf 'TeamIdentifier=%s\n' "$team" >&2
    else
      printf 'TeamIdentifier=not set\n' >&2
    fi
    if [[ "$runtime" == yes ]]; then
      printf 'CodeDirectory v=20500 flags=0x10000(runtime)\n' >&2
    else
      printf 'CodeDirectory v=20400 flags=0x0(none)\n' >&2
    fi
    ;;
  spctl)
    [[ "${FAKE_SPCTL_RESULT:-pass}" == pass ]]
    ;;
  *)
    echo "Unexpected fake tool: $tool_name" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$tool_dir/fake-tool"
for tool_name in plutil lipo otool codesign spctl; do
  ln -s "$tool_dir/fake-tool" "$tool_dir/$tool_name"
done

run_verifier() {
  env \
    TAKIO_PLUTIL_COMMAND="$tool_dir/plutil" \
    TAKIO_LIPO_COMMAND="$tool_dir/lipo" \
    TAKIO_OTOOL_COMMAND="$tool_dir/otool" \
    TAKIO_CODESIGN_COMMAND="$tool_dir/codesign" \
    TAKIO_SPCTL_COMMAND="$tool_dir/spctl" \
    FAKE_PLIST_EXECUTABLE="${FAKE_PLIST_EXECUTABLE:-takio}" \
    FAKE_PLIST_MINIMUM_VERSION="${FAKE_PLIST_MINIMUM_VERSION:-13.0}" \
    FAKE_MAIN_ARCHS="${FAKE_MAIN_ARCHS:-arm64}" \
    FAKE_SIDECAR_ARCHS="${FAKE_SIDECAR_ARCHS:-arm64}" \
    FAKE_MAIN_MINIMUM_VERSION="${FAKE_MAIN_MINIMUM_VERSION:-13.0}" \
    FAKE_SIDECAR_MINIMUM_VERSION="${FAKE_SIDECAR_MINIMUM_VERSION:-13.0}" \
    FAKE_MAIN_DEPENDENCIES="${FAKE_MAIN_DEPENDENCIES:-/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit}" \
    FAKE_SIDECAR_DEPENDENCIES="${FAKE_SIDECAR_DEPENDENCIES:-/usr/lib/libSystem.B.dylib}" \
    FAKE_CODESIGN_VERIFY="${FAKE_CODESIGN_VERIFY:-pass}" \
    FAKE_APP_TEAM="${FAKE_APP_TEAM-ABCDE12345}" \
    FAKE_SIDECAR_TEAM="${FAKE_SIDECAR_TEAM-ABCDE12345}" \
    FAKE_APP_RUNTIME="${FAKE_APP_RUNTIME:-yes}" \
    FAKE_SIDECAR_RUNTIME="${FAKE_SIDECAR_RUNTIME:-yes}" \
    FAKE_SPCTL_RESULT="${FAKE_SPCTL_RESULT:-pass}" \
    bash "$verifier" "$@"
}

expect_failure() {
  local label="$1"
  local expected_message="$2"
  local output
  shift 2

  if output="$("$@" 2>&1)"; then
    echo "Expected failure: $label" >&2
    exit 1
  fi
  case "$output" in
    *"$expected_message"*) ;;
    *)
      echo "Wrong failure for $label" >&2
      echo "Expected message containing: $expected_message" >&2
      echo "Actual output: $output" >&2
      exit 1
      ;;
  esac
}

run_verifier "$bundle_path" >/dev/null
run_verifier --distribution "$bundle_path" >/dev/null

expect_failure "missing target" "expected exactly one explicit .app path" run_verifier
expect_failure "non-app target" "target must have a .app suffix" run_verifier "$test_root"
expect_failure "option-like target" "target path must not begin with '-'" run_verifier "-unsafe.app"

FAKE_SIDECAR_ARCHS=x86_64 \
  expect_failure "architecture mismatch" "architecture mismatch" run_verifier "$bundle_path"

FAKE_SIDECAR_MINIMUM_VERSION=14.0 \
  expect_failure "minimum system version mismatch" "requires macOS 14.0 but the bundle declares 13.0" run_verifier "$bundle_path"

for forbidden_dependency in \
  "/nix/store/example/lib/libExample.dylib" \
  "/opt/homebrew/opt/example/lib/libExample.dylib" \
  "/usr/local/lib/libExample.dylib" \
  "/Users/example/Developer/takio/libExample.dylib"; do
  FAKE_SIDECAR_DEPENDENCIES="$forbidden_dependency" \
    expect_failure "$forbidden_dependency" "non-system absolute dependency" run_verifier "$bundle_path"
done

FAKE_CODESIGN_VERIFY=fail \
  expect_failure "invalid signature" "strict deep code-signature verification failed" run_verifier --distribution "$bundle_path"

FAKE_APP_TEAM='' \
  expect_failure "missing team" "has no signing TeamIdentifier" run_verifier --distribution "$bundle_path"

FAKE_SIDECAR_RUNTIME=no \
  expect_failure "missing hardened runtime" "is not signed with the hardened runtime" run_verifier --distribution "$bundle_path"

FAKE_SIDECAR_TEAM=OTHER12345 \
  expect_failure "team mismatch" "signing-team mismatch" run_verifier --distribution "$bundle_path"

FAKE_SPCTL_RESULT=fail \
  expect_failure "Gatekeeper rejection" "Gatekeeper assessment failed" run_verifier --distribution "$bundle_path"

echo "verify-macos-bundle self-test: PASS"
