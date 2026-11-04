#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# GPUI release support is macOS-only. Other hosts retain the Rust CLI/TUI.
packages=(-p takio -p takio-engine)
if [[ "$(uname -s)" == Darwin ]]; then packages=(--workspace); fi
case "${1:-}" in
  build) cargo build --release "${packages[@]}" ;;
  check)
    cargo fmt --all --check
    cargo clippy "${packages[@]}" --all-targets -- -D warnings ;;
  test) cargo test "${packages[@]}" ;;
  *) echo 'Usage: scripts/check-rust-workspace.sh build|check|test' >&2; exit 1 ;;
esac
