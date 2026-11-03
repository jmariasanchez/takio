#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$#" -ne 1 || ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Usage: scripts/verify-release-version.sh v<major>.<minor>.<patch>' >&2
  exit 1
fi
cargo metadata --offline --no-deps --format-version 1 | python3 -c '
import json, sys
metadata = json.load(sys.stdin)
expected = sys.argv[1][1:]
versions = {"package.json": json.load(open("package.json"))["version"]}
for name in ("takio", "takio-desktop"):
    package = next(p for p in metadata["packages"] if p["name"] == name)
    versions[package["manifest_path"]] = package["version"]
for source, version in versions.items():
    if version != expected:
        sys.exit(f"Release version mismatch: {source} has {version}, tag has {expected}")
print(f"Release version verified: v{expected}")
' "$1"
