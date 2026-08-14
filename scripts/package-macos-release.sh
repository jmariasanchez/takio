#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "package-macos-release: $*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS packaging requires macOS"
fi

case "$(uname -m)" in
  arm64)
    export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/clang
    dmg_arch="aarch64"
    ;;
  x86_64)
    export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER=/usr/bin/clang
    dmg_arch="x64"
    ;;
  *) fail "unsupported macOS architecture: $(uname -m)" ;;
esac

export SDKROOT
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if [[ -z "${TAKIO_BUN_COMPILE_EXECUTABLE:-}" ]]; then
  TAKIO_BUN_COMPILE_EXECUTABLE="$(bun scripts/bootstrap-official-bun.ts)"
  export TAKIO_BUN_COMPILE_EXECUTABLE
  echo "Using official version-matched Bun compile executable: $TAKIO_BUN_COMPILE_EXECUTABLE"
else
  echo "Using caller-provided Bun compile executable: $TAKIO_BUN_COMPILE_EXECUTABLE"
fi

bundle_root="apps/desktop/src-tauri/target/release/bundle"
macos_bundle_dir="$bundle_root/macos"
dmg_dir="$bundle_root/dmg"
app_path="$macos_bundle_dir/Takio.app"
dmg_path="$dmg_dir/Takio_0.1.0_${dmg_arch}.dmg"
tarball_path="$bundle_root/Takio.app.tar.gz"

rm -f "$dmg_path" "$dmg_path.sha256" "$tarball_path" "$tarball_path.sha256"
rm -f "$macos_bundle_dir"/rw.*.dmg 2>/dev/null || true

bun run --filter '@takio/desktop' tauri build --bundles app -- --locked
bash scripts/verify-macos-bundle.sh "$app_path"

bundle_script="$dmg_dir/bundle_dmg.sh"
[[ -x "$bundle_script" ]] || fail "Tauri did not generate bundle_dmg.sh: $bundle_script"

(
  cd "$macos_bundle_dir"
  ../dmg/bundle_dmg.sh \
    --skip-jenkins \
    --volname Takio \
    --icon Takio.app 180 170 \
    --app-drop-link 480 170 \
    --window-size 660 400 \
    --hide-extension Takio.app \
    --volicon "$(pwd)/../dmg/icon.icns" \
    "../dmg/$(basename "$dmg_path")" \
    Takio.app
)

if bash scripts/verify-macos-dmg.sh "$dmg_path" Takio.app; then
  echo "Packaged verified DMG: $dmg_path"
else
  echo "DMG verification failed. Building verified app tarball fallback." >&2
  tar -C "$macos_bundle_dir" -czf "$tarball_path" Takio.app
  shasum -a 256 "$tarball_path" > "$tarball_path.sha256"
  echo "Packaged verified app tarball fallback: $tarball_path" >&2
  exit 2
fi
