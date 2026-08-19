#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native macOS checks require macOS." >&2
  exit 1
fi

case "$(uname -m)" in arm64|x86_64) ;; *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;; esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

if [[ -z "${TAKIO_BUN_COMPILE_EXECUTABLE:-}" ]]; then
  TAKIO_BUN_COMPILE_EXECUTABLE="$(bun scripts/bootstrap-official-bun.ts)"
  export TAKIO_BUN_COMPILE_EXECUTABLE
  echo "Using official version-matched Bun compile executable: $TAKIO_BUN_COMPILE_EXECUTABLE"
else
  echo "Using caller-provided Bun compile executable: $TAKIO_BUN_COMPILE_EXECUTABLE"
fi

bun run --filter '@takio/desktop' check
bun run --filter '@takio/desktop' test
bun run --filter '@takio/desktop' build
