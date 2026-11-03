#!/usr/bin/env bash
# Assemble, ad-hoc sign, verify, and launch-test the standalone macOS bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "Packaging requires macOS" >&2; exit 1; }
[[ "$(uname -m)" == arm64 ]] || { echo "Native packaging currently supports Apple Silicon only" >&2; exit 1; }
[[ "$#" == 0 ]] || { echo "Usage: scripts/package-desktop-native.sh" >&2; exit 1; }
version=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
bash scripts/verify-release-version.sh "v$version"
binary=$(cargo build --release -p takio-desktop --message-format=json-render-diagnostics | python3 -c '
import json, sys
artifacts = [json.loads(line) for line in sys.stdin if line.strip()]
paths = {entry["executable"] for entry in artifacts
         if entry.get("reason") == "compiler-artifact"
         and entry.get("target", {}).get("name") == "takio-desktop"
         and entry.get("executable")}
if len(paths) != 1:
    sys.exit("Cargo did not report exactly one native executable")
print(paths.pop())
')
[[ -x "$binary" ]] || { echo "Cargo native executable is missing: $binary" >&2; exit 1; }
mkdir -p dist
stage=$(mktemp -d "$PWD/dist/.native-package.XXXXXX")
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-package-test.XXXXXX")
trap 'rm -rf "$stage" "$root"' EXIT
bundle="$stage/Takio.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "$binary" "$bundle/Contents/MacOS/takio-desktop"
cp apps/desktop-native/resources/icon.icns "$bundle/Contents/Resources/icon.icns"
python3 - "$version" "$bundle/Contents/Info.plist" <<'PY'
import pathlib, sys
source = pathlib.Path('apps/desktop-native/resources/Info.plist').read_text()
pathlib.Path(sys.argv[2]).write_text(source.replace('@VERSION@',sys.argv[1]))
PY
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
bash scripts/verify-macos-bundle.sh "$bundle"
python3 - "$bundle/Contents/MacOS/takio-desktop" "$root" <<'PY'
import json, os, subprocess, sys
result = subprocess.run([sys.argv[1]],env={**os.environ,'TAKIO_DATA_DIR':sys.argv[2]+'/library','TAKIO_DESKTOP_PROFILE_DIR':sys.argv[2]+'/profile','TAKIO_DESKTOP_BENCH':'1'},capture_output=True,text=True,timeout=30,check=True)
lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
if len(lines) != 1 or lines[0].get('items') != 0 or not all(key in lines[0] for key in ('firstPaintMs','firstQueryMs','rssKb')):
    raise SystemExit(f'Bundle startup did not produce valid metrics: {result.stdout}\n{result.stderr}')
print('Bundle startup: '+json.dumps(lines[0]))
PY
rm -rf "$PWD/dist/Takio.app"
mv "$bundle" "$PWD/dist/Takio.app"
bundle="$PWD/dist/Takio.app"
printf 'Bundle: %s\n' "$bundle"
du -sh "$bundle"
python3 - "$bundle" <<'PY'
import pathlib, sys
print('Bundle bytes: '+str(sum(p.stat().st_size for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file())))
PY
