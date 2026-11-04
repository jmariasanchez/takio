#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Native macOS checks require macOS." >&2
  exit 1
fi

case "$(uname -m)" in arm64|x86_64) ;; *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;; esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

cargo fmt --all --check
native_dependencies=$(cargo tree --offline -p takio-desktop -e normal)
if grep -E 'clap|ratatui|tiny_http' <<< "$native_dependencies"; then
  echo 'Native desktop must not depend on CLI, terminal, or HTTP server adapters.' >&2
  exit 1
fi
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p takio-desktop
test "$(wc -c < target/release/takio-desktop)" -lt 12000000
bash scripts/test-verify-macos-bundle.sh
bash scripts/test-release-scripts.sh
