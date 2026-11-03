#!/usr/bin/env bash
# Deterministic 10k catalogue, five real GUI starts, independently enforced medians.
set -euo pipefail
interactions=0
render=0
if [[ "${1:-}" == --render-interactions && $# == 1 ]]; then
    interactions=1
    render=1
elif [[ "${1:-}" == --interactions && $# == 1 ]]; then
    interactions=1
elif [[ $# != 0 ]]; then
    echo "Usage: $0 [--interactions|--render-interactions]" >&2
    exit 2
fi
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo "Native desktop benchmark requires macOS" >&2; exit 1; }
if [[ "${TAKIO_BENCH_SKIP_BUILD:-0}" != 1 ]]; then
    cargo build --release -p takio-desktop -p takio
fi
root=$(mktemp -d "${JCODE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/takio-desktop-bench.XXXXXX")
if [[ "${TAKIO_BENCH_KEEP_FIXTURE:-0}" == 1 ]]; then
    echo "Retained benchmark fixture: $root"
else
    trap 'rm -rf "$root"' EXIT
fi
mkdir "$root/benchmark-volumes"
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
python3 - "$PWD/target/release/takio-desktop" "$root" "$interactions" "$render" <<'PY'
import json, math, os, statistics, subprocess, sys
binary, root, interactions, render = sys.argv[1:]
# A contended build is not credible latency evidence. Refuse, rather than silently
# publish an apparent regression from another worker's compiler workload.
def check_contention():
    processes = subprocess.check_output(['ps', '-Ao', 'comm='], text=True).splitlines()
    if any(os.path.basename(command.strip()) in {'cargo', 'rustc'} for command in processes):
        raise SystemExit('Refusing latency measurement while cargo/rustc is active. Retry after builds finish.')
check_contention()
print('Startup scope: direct temporary-library engine/workspace open, excluding remembered-library lookup and startup recovery UI.', flush=True)
samples = []
interaction_samples = []
if interactions == '1':
    print('Interaction scope: native Search input-handler injection to next frame after settled workspace paint submission, plus programmatic virtualized scroll. Not hardware keystrokes, wheel events, GPU completion or display scanout.' if render == '1' else 'Interaction scope: production state dispatch to settled notification in real GUI, including 8ms debounce. Not input-to-paint or scrolling.', flush=True)
for index in range(5):
    check_contention()
    try:
        result = subprocess.run([binary], env={**os.environ, 'TAKIO_DATA_DIR':root, 'TAKIO_DESKTOP_BENCH':'1', 'TAKIO_DESKTOP_BENCH_INTERACTIONS':interactions, 'TAKIO_DESKTOP_BENCH_RENDER':render}, capture_output=True, text=True, timeout=180 if interactions == '1' else 30, check=True)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        raise SystemExit(f'FAIL run {index+1}: {error}\nstdout: {error.stdout}\nstderr: {error.stderr}')
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    startup = [line for line in lines if 'kind' not in line]
    if len(startup) != 1 or startup[0].get('items') != 10000:
        raise SystemExit(f'Invalid startup result: {result.stdout}\n{result.stderr}')
    sample = startup[0]
    if any(not isinstance(sample.get(key), (int,float)) or sample[key] <= 0 for key in ('firstPaintMs','firstQueryMs','rssKb')):
        raise SystemExit(f'Missing or invalid measurement: {sample}')
    samples.append(sample)
    print(f'Run {index+1}: {json.dumps(sample)}', flush=True)
    if interactions == '1':
        rows = [line for line in lines if line.get('kind') == 'interaction']
        complete = [line for line in lines if line.get('kind') == 'interactions_complete']
        expected_operations = {'query_signal':5000, 'query_clear':10000, 'sort_title':10000, 'select_all_reload':10000}
        if render == '1':
            expected_operations.update({'scroll_bottom':10000, 'scroll_top':10000})
        expected_samples = 5 * len(expected_operations)
        if len(rows) != expected_samples or complete != [{'kind':'interactions_complete', 'samples':expected_samples}]:
            raise SystemExit(f'Incomplete interaction results: {result.stdout}\n{result.stderr}')
        for operation, expected in expected_operations.items():
            matching = [row for row in rows if row.get('operation') == operation]
            if len(matching) != 5 or sorted(row.get('sample', 0) for row in matching) != list(range(1, 6)):
                raise SystemExit(f'Missing samples for {operation}: {matching}')
            for row in matching:
                if row.get('correct') is not True or row.get('items') != expected or row.get('expectedItems') != expected:
                    raise SystemExit(f'Incorrect interaction result: {row}')
                if operation == 'select_all_reload' and row.get('selectedItems') != expected:
                    raise SystemExit(f'Incorrect retained selection: {row}')
                keys = ('settledMs', 'dispatchMs', 'renderCompleteMs') if render == '1' else ('settledMs', 'dispatchMs')
                for key in keys:
                    value = row.get(key)
                    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                        raise SystemExit(f'Invalid interaction timing: {row}')
                if render == '1' and row['renderCompleteMs'] < row['settledMs']:
                    raise SystemExit(f'Render completed before result settlement: {row}')
                if operation.startswith('query_') and row['settledMs'] < 8:
                    raise SystemExit(f'Query timing excluded debounce: {row}')
                print(f'Interaction run {index+1}: {json.dumps(row)}', flush=True)
        interaction_samples.extend(rows)
medians = {key:statistics.median(sample[key] for sample in samples) for key in ('firstPaintMs','firstQueryMs','rssKb')}
print('Medians: ' + json.dumps(medians), flush=True)
interaction_failures = []
search_target_failures = []
interaction_budgets = {('sort_title', 'dispatchMs'):8, ('select_all_reload', 'settledMs'):200}
for operation in sorted({row['operation'] for row in interaction_samples}):
    rows = [row for row in interaction_samples if row['operation'] == operation]
    summary = {'operation':operation, 'samples':len(rows), 'correct':True}
    keys = ('settledMs', 'dispatchMs', 'renderCompleteMs') if render == '1' else ('settledMs', 'dispatchMs')
    for key in keys:
        values = sorted(row[key] for row in rows)
        summary[key] = {'median':statistics.median(values), 'max':max(values)}
        if len(values) >= 20:
            summary[key]['p95'] = values[math.ceil(len(values) * .95) - 1]
        budget = interaction_budgets.get((operation, key))
        if budget is not None:
            p95 = summary[key].get('p95')
            if p95 is None or p95 > budget:
                interaction_failures.append(f'{operation}.{key}.p95={p95} > {budget}ms or insufficient samples')
    print('Interaction summary (nearest-rank p95, >=20 samples): ' + json.dumps(summary), flush=True)
    if operation.startswith('query_'):
        metric = 'renderCompleteMs' if render == '1' else 'settledMs'
        observed = summary[metric]['p95']
        if observed >= 80:
            search_target_failures.append(f'{operation}.{metric}.p95={observed}ms >=80ms')
        first = [row[metric] for row in rows if row['sample'] == 1]
        print('First-query-per-process (not filesystem-cold): ' + json.dumps({'operation':operation, 'metric':metric, 'samples':len(first), 'median':statistics.median(first), 'max':max(first)}), flush=True)
if interactions == '1':
    print('Search <80ms p95 target: ' + ('NOT MET: ' + ', '.join(search_target_failures) if search_target_failures else 'MET for this measured scope only'), flush=True)
    if os.environ.get('TAKIO_BENCH_REQUIRE_SEARCH_TARGET') == '1':
        interaction_failures.extend(search_target_failures)
failed = [f'{key}={medians[key]} > {budget}' for key,budget in [('firstPaintMs',150),('firstQueryMs',400),('rssKb',150000)] if medians[key] > budget]
failed.extend(interaction_failures)
if failed:
    raise SystemExit('FAIL: ' + ', '.join(failed))
print('PASS: native desktop startup budgets')
if interactions == '1':
    print('PASS: state interaction budgets: sort dispatch p95 <=8ms, select-all/reload settlement p95 <=200ms (not paint budgets)')
PY
