#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "package-macos-release: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS packaging requires macOS"
case "$(uname -m)" in arm64|x86_64) ;; *) fail "unsupported macOS architecture: $(uname -m)" ;; esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if [[ -z "${TAKIO_BUN_COMPILE_EXECUTABLE:-}" ]]; then
  export TAKIO_BUN_COMPILE_EXECUTABLE="$(bun scripts/bootstrap-official-bun.ts)"
fi

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  export CSC_NAME="$APPLE_SIGNING_IDENTITY"
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
if [[ -n "${APPLE_PASSWORD:-}" ]]; then
  export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_PASSWORD"
fi

bun run --filter '@takio/desktop' package

app_path="apps/desktop/release/mac-arm64/Takio.app"
[[ -d "$app_path" ]] || app_path="$(find apps/desktop/release -maxdepth 2 -type d -name Takio.app -print -quit)"
[[ -n "$app_path" && -d "$app_path" ]] || fail "electron-builder did not produce Takio.app"
bash scripts/verify-macos-bundle.sh "$app_path"

dmg_path="$(find apps/desktop/release -maxdepth 1 -type f -name '*.dmg' -print -quit)"
[[ -n "$dmg_path" ]] || fail "electron-builder did not produce a DMG"
bash scripts/verify-macos-dmg.sh "$dmg_path" Takio.app
echo "Packaged verified Electron DMG: $dmg_path"
