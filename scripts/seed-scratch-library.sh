#!/usr/bin/env bash
# Seed a scratch library for manual desktop testing. Idempotent-ish: reruns
# add duplicates, so point TAKIO_SEED_DIR at a fresh directory.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
takio="$root/target/release/takio"
dir="${TAKIO_SEED_DIR:?set TAKIO_SEED_DIR to an empty directory}"
mkdir -p "$dir/books"
db="$dir/library.sqlite"

seed() {
  local title="$1" author="$2" series="${3:-}"
  local file="$dir/books/$title.epub"
  printf 'book %s\n' "$title" > "$file"
  "$takio" library import --db "$db" --source-path "$file" --title "$title" >/dev/null
  local id
  id="$("$takio" library search --db "$db" --query "$title" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"]["items"][0]["id"])')"
  local patch
  if [[ -n "$series" ]]; then
    patch="{\"authors\":[{\"name\":\"$author\"}],\"tags\":[\"sf\"],\"series\":\"$series\"}"
  else
    patch="{\"authors\":[{\"name\":\"$author\"}],\"tags\":[\"sf\"]}"
  fi
  "$takio" library update --db "$db" --id "$id" --patch-json "$patch" >/dev/null
}

seed "Dune" "Frank Herbert" "Dune"
seed "Dune Messiah" "Frank Herbert" "Dune"
seed "Neuromancer" "William Gibson" "Sprawl"
seed "The Left Hand of Darkness" "Ursula K. Le Guin" "Hainish Cycle"
seed "The Dispossessed" "Ursula K. Le Guin" "Hainish Cycle"
seed "Snow Crash" "Neal Stephenson"
seed "Anathem" "Neal Stephenson"
seed "Hyperion" "Dan Simmons" "Hyperion Cantos"
seed "Foundation" "Isaac Asimov" "Foundation"
seed "A Fire Upon the Deep" "Vernor Vinge"
"$takio" library list --db "$db" --human
