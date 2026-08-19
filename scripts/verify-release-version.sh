#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 || ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Usage: scripts/verify-release-version.sh v<major>.<minor>.<patch>" >&2
  exit 1
fi

tag_version="${1#v}"
root_version="$(bun -p 'require("./package.json").version')"
desktop_version="$(bun -p 'require("./apps/desktop/package.json").version')"
for version_source in \
  "package.json:$root_version" \
  "apps/desktop/package.json:$desktop_version"; do
  source_path="${version_source%%:*}"
  source_version="${version_source#*:}"
  if [[ "$source_version" != "$tag_version" ]]; then
    echo "Release version mismatch: $source_path has '$source_version', tag has '$tag_version'." >&2
    exit 1
  fi
done

echo "Release version verified: $1"
