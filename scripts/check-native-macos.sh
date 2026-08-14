#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native macOS checks require macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)
    export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/clang
    ;;
  x86_64)
    export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER=/usr/bin/clang
    ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
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

bun run --filter '@takio/desktop' build:engine
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
