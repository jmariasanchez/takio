#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 || ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: scripts/verify-release-version.sh v<major>.<minor>.<patch>" >&2
  exit 1
fi

tag_version="${1#v}"
root_version="$(bun -p 'require("./package.json").version')"
desktop_version="$(bun -p 'require("./apps/desktop/package.json").version')"
tauri_version="$(bun -p 'require("./apps/desktop/src-tauri/tauri.conf.json").version')"
cargo_version="$(awk '
  /^\[package\]$/ { in_package = 1; next }
  /^\[/ { in_package = 0 }
  in_package && /^version = / { gsub(/^version = "|"$/, ""); print; exit }
' apps/desktop/src-tauri/Cargo.toml)"

for version_source in \
  "package.json:$root_version" \
  "apps/desktop/package.json:$desktop_version" \
  "apps/desktop/src-tauri/tauri.conf.json:$tauri_version" \
  "apps/desktop/src-tauri/Cargo.toml:$cargo_version"; do
  source_path="${version_source%%:*}"
  source_version="${version_source#*:}"
  if [[ "$source_version" != "$tag_version" ]]; then
    echo "Release version mismatch: $source_path has '$source_version', tag has '$tag_version'." >&2
    exit 1
  fi
done

echo "Release version verified: $1"
