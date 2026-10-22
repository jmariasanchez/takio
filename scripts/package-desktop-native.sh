#!/usr/bin/env bash
# Assemble, ad-hoc sign, verify, and launch-test the standalone macOS bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "Packaging requires macOS" >&2; exit 1; }
cargo build --release -p takio-desktop
bundle="$PWD/dist/Takio.app"
# This is generated output. Never retain frameworks from a previous desktop build.
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp target/release/takio-desktop "$bundle/Contents/MacOS/takio-desktop"
cp apps/desktop-native/resources/icon.icns "$bundle/Contents/Resources/icon.icns"
version=$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "takio-desktop"))')
python3 - "$version" "$bundle/Contents/Info.plist" <<'PY'
import pathlib, sys
source = pathlib.Path('apps/desktop-native/resources/Info.plist').read_text()
pathlib.Path(sys.argv[2]).write_text(source.replace('@VERSION@',sys.argv[1]))
PY
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - --deep "$bundle"
codesign --verify --deep --strict --verbose=2 "$bundle"
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-package-test.XXXXXX")
trap 'rm -rf "$root"' EXIT
python3 - "$bundle/Contents/MacOS/takio-desktop" "$root" <<'PY'
import json, os, subprocess, sys
result = subprocess.run([sys.argv[1]],env={**os.environ,'TAKIO_DATA_DIR':sys.argv[2],'TAKIO_DESKTOP_BENCH':'1'},capture_output=True,text=True,timeout=30,check=True)
lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
if len(lines) != 1 or lines[0].get('items') != 0 or not all(key in lines[0] for key in ('firstPaintMs','firstQueryMs','rssKb')):
    raise SystemExit(f'Bundle startup did not produce valid metrics: {result.stdout}\n{result.stderr}')
print('Bundle startup: '+json.dumps(lines[0]))
PY
printf 'Bundle: %s\n' "$bundle"
du -sh "$bundle"
python3 - "$bundle" <<'PY'
import pathlib, sys
print('Bundle bytes: '+str(sum(p.stat().st_size for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file())))
PY
