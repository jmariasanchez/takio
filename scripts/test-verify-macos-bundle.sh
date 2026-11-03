#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-bundle-verifier.XXXXXX")
trap 'rm -rf "$root"' EXIT
bundle="$root/Fixture Bundle.app"
mkdir -p "$root/tools" "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
touch "$bundle/Contents/Info.plist" "$bundle/Contents/Resources/icon.icns" "$bundle/Contents/MacOS/takio-desktop"
chmod +x "$bundle/Contents/MacOS/takio-desktop"
cat > "$root/tools/fake-tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0")" in
  plutil)
    case "$2" in
      CFBundleExecutable) echo "${FAKE_EXECUTABLE:-takio-desktop}" ;;
      LSMinimumSystemVersion) echo 13.0 ;;
      CFBundleShortVersionString|CFBundleVersion) echo "${FAKE_VERSION:-0.1.0}" ;;
    esac ;;
  lipo) echo "${FAKE_ARCH:-arm64}" ;;
  otool)
    if [[ "$1" == -l ]]; then
      printf 'Load command 0\n cmd LC_BUILD_VERSION\n minos %s\n' "${FAKE_MINIMUM:-13.0}"
    else
      printf '%s:\n\t%s (compatibility version 1.0.0, current version 1.0.0)\n' "$2" "${FAKE_DEPENDENCY:-/usr/lib/libSystem.B.dylib}"
    fi ;;
  codesign)
    if [[ "$1" == --verify ]]; then
      [[ "${FAKE_SIGNATURE:-pass}" == pass ]]
    else
      team="${FAKE_TEAM-ABCDE12345}"
      [[ "$*" != *'/MacOS/'* ]] || team="${FAKE_EXECUTABLE_TEAM-$team}"
      echo "TeamIdentifier=$team" >&2
      echo "CodeDirectory flags=${FAKE_RUNTIME:-0x10000(runtime)}" >&2
    fi ;;
  spctl) [[ "${FAKE_GATEKEEPER:-pass}" == pass ]] ;;
esac
EOF
chmod +x "$root/tools/fake-tool"
for tool in plutil lipo otool codesign spctl; do ln -s fake-tool "$root/tools/$tool"; done
export TAKIO_PLUTIL_COMMAND="$root/tools/plutil" TAKIO_LIPO_COMMAND="$root/tools/lipo"
export TAKIO_OTOOL_COMMAND="$root/tools/otool" TAKIO_CODESIGN_COMMAND="$root/tools/codesign"
export TAKIO_SPCTL_COMMAND="$root/tools/spctl" TAKIO_EXPECTED_VERSION=0.1.0
verify() { bash "$repo_root/scripts/verify-macos-bundle.sh" "$@"; }
reject() {
  local expected="$1" output
  shift
  if output=$("$@" 2>&1); then echo "Expected rejection: $expected" >&2; exit 1; fi
  [[ "$output" == *"$expected"* ]] || { echo "Wrong rejection: $output (expected $expected)" >&2; exit 1; }
}
verify "$bundle" >/dev/null
verify --distribution "$bundle" >/dev/null
reject 'expected exactly one explicit .app path' verify
reject 'target must have a .app suffix' verify "$root"
reject "target path must not begin with '-'" verify -bad.app
FAKE_EXECUTABLE=Takio reject 'expected native CFBundleExecutable' verify "$bundle"
FAKE_EXECUTABLE=../takio reject 'must be a file name' verify "$bundle"
FAKE_VERSION=0.2.0 reject 'version mismatch' verify "$bundle"
FAKE_ARCH=x86_64 reject 'unsupported architecture' verify "$bundle"
FAKE_MINIMUM=14.0 reject 'requires macOS 14.0' verify "$bundle"
for dependency in /nix/store/example.dylib /opt/homebrew/lib/example.dylib /usr/local/lib/example.dylib /Users/example/lib.dylib; do
  FAKE_DEPENDENCY="$dependency" reject 'non-system absolute dependency' verify "$bundle"
done
FAKE_DEPENDENCY=@rpath/missing.dylib reject 'unexpected dependency reference' verify "$bundle"
FAKE_SIGNATURE=fail reject 'strict deep code-signature verification failed' verify "$bundle"
FAKE_SIGNATURE=fail reject 'strict deep code-signature verification failed' verify --distribution "$bundle"
FAKE_TEAM='' reject 'no signing TeamIdentifier' verify --distribution "$bundle"
FAKE_RUNTIME=0x0 reject 'not signed with the hardened runtime' verify --distribution "$bundle"
FAKE_EXECUTABLE_TEAM=OTHER12345 reject 'signing-team mismatch' verify --distribution "$bundle"
FAKE_GATEKEEPER=fail reject 'Gatekeeper assessment failed' verify --distribution "$bundle"
mkdir "$bundle/Contents/Frameworks"
reject 'must not contain Frameworks' verify "$bundle"
rmdir "$bundle/Contents/Frameworks"
mkdir "$bundle/Contents/Resources/bin"
reject 'must not contain sidecars' verify "$bundle"
rmdir "$bundle/Contents/Resources/bin"
rm "$bundle/Contents/MacOS/takio-desktop"
reject 'missing bundled executable' verify "$bundle"
echo 'verify-macos-bundle self-test: PASS (native shape, version, architecture, OS, dependencies, signatures, Gatekeeper)'
