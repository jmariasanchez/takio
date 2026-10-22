#!/usr/bin/env bash
# Head-to-head startup comparison: Electron desktop vs native GPUI desktop,
# same machine, same deterministic 10,000-book library. Prints medians of
# five launches for each. Informational, not a CI gate.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "requires macOS" >&2; exit 1; }

cargo build --release -p takio -p takio-desktop >/dev/null 2>&1
bun run --filter '@takio/desktop' build >/dev/null 2>&1

root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-compare.XXXXXX")
trap 'rm -rf "$root"' EXIT
printf seed > "$root/seed.epub"
target/release/takio library add --db "$root/library.sqlite" --source-path "$root/seed.epub" >/dev/null
# Reuse the exact fixture SQL from the native bench so both apps see one library.
sed -n '/^sqlite3/,/^SQL$/p' scripts/bench-desktop-native.sh | sed '1d;$d' | sqlite3 "$root/library.sqlite"
items=$(target/release/takio library list --db "$root/library.sqlite" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["value"]["items"]))')
echo "library: $items items at $root"

python3 - "$root" "$PWD" <<'PY'
import json, os, statistics, subprocess, sys, time
root, repo = sys.argv[1:]
env = {**os.environ, "TAKIO_DATA_DIR": root}

def rss_kb(pid):
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) if out else 0

def electron_run():
    # Electron prints TAKIO_LIBRARY_USABLE on stderr once the renderer has
    # queried the engine; that is its equivalent of "first query landed".
    started = time.perf_counter()
    p = subprocess.Popen([f"{repo}/apps/desktop/node_modules/.bin/electron", f"{repo}/apps/desktop"],
                         env={**env, "TAKIO_STARTUP_BENCHMARK": "1"},
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    usable = None
    while True:
        line = p.stderr.readline()
        if not line:
            break
        if "TAKIO_LIBRARY_USABLE" in line:
            usable = (time.perf_counter() - started) * 1000
            break
    time.sleep(1.0)  # let it settle before sampling memory
    # Sum RSS across the whole Electron process tree (main + renderer + gpu + sidecar).
    tree = subprocess.run(["pgrep", "-f", "apps/desktop"], capture_output=True, text=True).stdout.split()
    rss = sum(rss_kb(int(x)) for x in tree if x.isdigit())
    p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill()
    return {"usableMs": usable, "rssKb": rss}

def native_run():
    r = subprocess.run([f"{repo}/target/release/takio-desktop"], env={**env, "TAKIO_DESKTOP_BENCH": "1"},
                       capture_output=True, text=True, timeout=30, check=True)
    line = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")][0]
    return {"usableMs": line["firstQueryMs"], "rssKb": line["rssKb"]}

def medians(samples, keys):
    return {k: round(statistics.median(s[k] for s in samples if s[k] is not None), 1) for k in keys}

e = [electron_run() for _ in range(5)]
n = [native_run() for _ in range(5)]
em, nm = medians(e, ["usableMs", "rssKb"]), medians(n, ["usableMs", "rssKb"])
print(f"electron  library-usable median {em['usableMs']:>8} ms   rss (process tree) {em['rssKb']/1024:>7.0f} MB")
print(f"native    library-usable median {nm['usableMs']:>8} ms   rss               {nm['rssKb']/1024:>7.0f} MB")
if em["usableMs"] and nm["usableMs"]:
    print(f"native is {em['usableMs']/nm['usableMs']:.1f}x faster to usable, {em['rssKb']/nm['rssKb']:.1f}x less memory")
PY
