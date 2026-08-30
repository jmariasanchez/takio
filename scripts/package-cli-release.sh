#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(sed -n 's/^version = "\([^"]*\)"/\1/p' Cargo.toml | head -n 1)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "package-cli-release: invalid Cargo workspace version" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) echo "package-cli-release: unsupported platform" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x86_64" ;;
  *) echo "package-cli-release: unsupported architecture" >&2; exit 1 ;;
esac

source_path="$root/target/release/takio"
[[ -x "$source_path" ]] || { echo "package-cli-release: release binary is unavailable" >&2; exit 1; }

output_directory="$root/dist/releases"
mkdir -p "$output_directory"
artifact_name="takio-v${version}-${platform}-${architecture}"
artifact_path="$output_directory/$artifact_name"
checksum_path="$artifact_path.sha256"
[[ ! -e "$artifact_path" && ! -e "$checksum_path" ]] || {
  echo "package-cli-release: output-file-exists" >&2
  exit 1
}

cp -p "$source_path" "$artifact_path"
chmod 755 "$artifact_path"
if command -v shasum >/dev/null 2>&1; then
  digest="$(shasum -a 256 "$artifact_path" | awk '{print $1}')"
else
  digest="$(sha256sum "$artifact_path" | awk '{print $1}')"
fi
printf '%s  %s\n' "$digest" "$artifact_name" > "$checksum_path"
printf '{"ok":true,"value":{"release":{"artifactPath":"%s","checksumPath":"%s","sha256":"%s"}}}\n' \
  "$artifact_path" "$checksum_path" "$digest"
