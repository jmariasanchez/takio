#!/usr/bin/env bash
# Deterministic 10k catalogue, five real GUI starts, independently enforced medians.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "Native desktop benchmark requires macOS" >&2; exit 1; }
cargo build --release -p takio-desktop -p takio
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-desktop-bench.XXXXXX")
trap 'rm -rf "$root"' EXIT
printf seed > "$root/seed.epub"
target/release/takio library add --db "$root/library.sqlite" --source-path "$root/seed.epub" > "$root/seed.json"
sqlite3 "$root/library.sqlite" <<'SQL'
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
DELETE FROM library_items;
CREATE TEMP TABLE fixture AS WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<9999) SELECT i, printf('book-%05d',i) id, '2026-01-01T12:00:00.000Z' added_at FROM n;
INSERT INTO library_items(id,title,added_at,author,series,series_index,publisher,published_date,rating,description,updated_at)
SELECT id,printf('%s volume %s',CASE WHEN i%2=0 THEN 'Signal' ELSE 'Archive' END,id),added_at,printf('Author %03d',i%97),printf('Series %02d',i%23),i%12+1,printf('Publisher %02d',i%13),printf('%d',1980+i%45),i%11,printf('Deterministic catalogue record %d.',i),added_at FROM fixture;
INSERT INTO library_item_formats(library_item_id,format,source_path,added_at,provenance,position)
SELECT id,'epub','/reference-catalogue/'||id||'.epub',added_at,'referenced',0 FROM fixture;
INSERT INTO library_item_formats(library_item_id,format,source_path,added_at,provenance,position)
SELECT id,'pdf','/reference-catalogue/'||id||'.pdf',added_at,'referenced',1 FROM fixture WHERE i%2=0;
INSERT INTO library_item_authors(library_item_id,name,sort_name,position)
SELECT id,printf('Author %03d',i%97),printf('Writer %03d',i%97),0 FROM fixture;
INSERT INTO library_item_languages(library_item_id,language,position)
SELECT id,CASE i%3 WHEN 0 THEN 'en' WHEN 1 THEN 'fr' ELSE 'de' END,0 FROM fixture;
INSERT INTO library_item_identifiers(library_item_id,scheme,value) SELECT id,'fixture',id FROM fixture;
INSERT INTO tags(normalized_name,name) VALUES('classic','Classic'),('research','Research'),('reference','Reference'),('award winner','Award winner'),('contemporary','Contemporary'),('history','History'),('science','Science');
INSERT INTO library_item_tags(library_item_id,tag_normalized_name,position)
SELECT id,CASE i%7 WHEN 0 THEN 'classic' WHEN 1 THEN 'research' WHEN 2 THEN 'reference' WHEN 3 THEN 'award winner' WHEN 4 THEN 'contemporary' WHEN 5 THEN 'history' ELSE 'science' END,0 FROM fixture;
COMMIT;
SQL
python3 - "$PWD/target/release/takio-desktop" "$root" <<'PY'
import json, os, statistics, subprocess, sys
binary, root = sys.argv[1:]
samples = []
for index in range(5):
    result = subprocess.run([binary], env={**os.environ, 'TAKIO_DATA_DIR':root, 'TAKIO_DESKTOP_BENCH':'1'}, capture_output=True, text=True, timeout=30, check=True)
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    if len(lines) != 1 or lines[0].get('items') != 10000:
        raise SystemExit(f'Invalid startup result: {result.stdout}\n{result.stderr}')
    sample = lines[0]
    if any(not isinstance(sample.get(key), (int,float)) or sample[key] <= 0 for key in ('firstPaintMs','firstQueryMs','rssKb')):
        raise SystemExit(f'Missing or invalid measurement: {sample}')
    samples.append(sample)
    print(f'Run {index+1}: {json.dumps(sample)}', flush=True)
medians = {key:statistics.median(sample[key] for sample in samples) for key in ('firstPaintMs','firstQueryMs','rssKb')}
print('Medians: ' + json.dumps(medians), flush=True)
failed = [f'{key}={medians[key]} > {budget}' for key,budget in [('firstPaintMs',150),('firstQueryMs',400),('rssKb',150000)] if medians[key] > budget]
if failed:
    raise SystemExit('FAIL: ' + ', '.join(failed))
print('PASS: native desktop startup budgets')
PY
