# Desloppify code-health iteration

Date: 2026-11-03

## Scope and baseline

The user requested installation with `uv`, a whole-repository scan, and repeated
execution of Desloppify's living plan. The working tree was clean at `3d59f58`.
No personal libraries, connected readers, accounts, or release services are used.

Setup performed:

```sh
uv tool install --upgrade --python 3.12 "desloppify[full]"
desloppify update-skill claude
desloppify exclude target
desloppify exclude dist
desloppify exclude node_modules
desloppify exclude .git
desloppify exclude .takio/toolchains
desloppify scan --path .
desloppify next
```

Desloppify 1.0 selected Rust for the coherent Cargo workspace. This scan does not
establish TypeScript package health. Exclusions cover only build products,
dependencies, Git metadata, and the downloaded toolchain. External worktrees are
outside this checkout. Source, scripts, tests, and fixtures remain available.
`.desloppify/` is ignored, and the generated badge path is now
`.desloppify/scorecard.png` rather than a tracked repository-root artifact.

The initial strict score was **22.1/100**, with 669 open findings and all 20
subjective dimensions unassessed. Independent reviewer agents are unavailable
under this session's execution constraints. Those review requests are explicitly
deferred, not completed or assigned invented scores. Mechanical changes cannot
by themselves fill the subjective portion of the score.

The security alert at `metadata/pdf/tests.rs:220` is the literal password for an
in-memory synthetic encrypted-PDF fixture, not a credential. That file and
`store/query_cache/tests.rs` were incorrectly classified as production and have
explicit test-zone overrides. Any score movement from classification corrections
must be distinguished from improvements to application code.

## Acceptance recorded for the first implementation queue

- Cover publication owns its extension and media-type strings rather than leaking
  allocations on every metadata fetch. Preserve JSON fields, verified byte copies,
  source ownership, and refusal to overwrite destinations. Exercise repeated
  publication and collision paths with temporary fixtures.
- Metadata and maintenance use one executable-discovery implementation. Preserve
  explicit-override precedence, executable checks, PATH search, and the existing
  macOS fallback. Tests must not mutate the parent process environment.
- Decompose the large store around real domain responsibilities while preserving
  public imports, database transactions, hydration/cache invalidation, file
  ownership, and query semantics. Existing store, CLI, and native regressions
  remain the acceptance boundary, not reduced file lengths alone.
- Directly test JSON envelope shape, escaping, error redaction, and exit codes.
  Closed stdout must return failure without a panic. Exercise the actual CLI with
  a closed pipe as well as the output helper with a failing writer.
- Consolidate catalog projections without conflating CLI export and server
  response schemas or exposing filesystem paths. Test rich and sparse metadata.
- Document the shared library's engine/CLI boundary and operation ownership.

## Reproducible validation

```sh
cargo fmt --all --check
cargo test --offline -p takio
cargo test --offline --workspace
cargo clippy --offline --workspace --all-targets -- -D warnings
cargo doc --offline -p takio --no-deps
# Pin Rust explicitly in this mixed Rust/TypeScript repository:
desloppify --lang rust scan --path .
desloppify --lang rust next
git diff --check
```

## Observations during implementation

- The new executable-level output checks pass for successful JSON, invalid
  arguments, and closed stdout on both success and failure paths.
- An independent CLI-only library test build exposed an existing ambiguous
  `AsRef` byte comparison in the migration tests. This must be corrected without
  weakening the byte-preservation assertion. A passing workspace feature graph
  alone is not sufficient evidence for the standalone CLI crate.
- Concurrent implementation can temporarily leave module imports incomplete.
  Only final integrated test runs count as acceptance evidence.

## Verified implementation slices

- `8d37225`: CLI output returns write errors instead of panicking on closed
  stdout and exits through `ExitCode`. Six direct output tests and two actual
  executable tests pass, including physical JSON line boundaries and both success
  and failure responses with a closed output socket.
- `5ab202f`: fetched cover metadata owns its strings, removing the two leaked
  allocations. Publication preserves JSON fields, fingerprints, collision refusal
  and live/dangling symlink targets. Eight metadata tests, four discovery tests,
  maintenance validation and a real CLI fetch against an isolated fake backend pass.
  The fake backend proves process/serialization behavior, not Calibre compatibility.
- The same commit replaces the duplicated public catalog serializer with a typed
  field allowlist. Sparse/rich metadata, absent versus null fields, nonfinite
  floats, legacy authors, JSON/CSV export and an actual ephemeral-loopback HTTP
  request pass. The HTTP test checks authentication failure, response envelopes,
  no-store headers and omission of private paths, sort names and audit metadata.
- `ae35c9e`: path resolution and diagnostics now document actual errors and side
  effects, including a possible sync failure after publication. Diagnostic
  verification uses the existing read-only open API, avoiding unnecessary write
  access and creation capability. Four path tests and four diagnostic tests pass,
  including unchanged current/legacy/corrupt database bytes and directory entries.
  This is least-privilege hardening, not a claim that the old code always migrated
  a library: its `create=false` argument already prevented migration.

Strict CLI Clippy and `cargo doc --offline -p takio --no-deps` pass after these
changes. All four retained Bun packages pass their typechecks and tests on local
Bun 1.4.4. At that intermediate checkpoint, integrated native and rescan evidence
was still pending. The final results and remaining work are recorded below.

## Follow-through discovered during review

- `89d9a72`: shared backend discovery now pins the checked executable to its
  canonical path before metadata or maintenance changes the child working
  directory. Five discovery tests and six real CLI metadata tests pass, including
  bare/nested relative overrides, relative/empty PATH components, same-name PATH
  impostors and invalid authoritative overrides. Existing conversion regression
  tests also pass. A concrete findings-only review was imported and resolved
  after testing, without importing subjective assessments.
- `50765e5`: a real native subprocess with a removed disposable working directory
  reproduced a closed-stderr panic, exit 101 instead of the intended failure 1.
  Production startup now returns `ExitCode`, and diagnostic writes are fallible.
  Two executable tests cover exact messages and status with open/closed stderr
  for production startup and benchmark startup. The optional snapshot feature
  still compiles. No GUI or personal library is opened by these error tests.
- The remaining native `process::exit` is deliberately retained only for opt-in
  acceptance-probe failures. Inspection of the installed GPUI macOS implementation
  shows `quit` invokes Cocoa `terminate:`, not an event-loop return that could
  carry a failure back to `main`. Replacing it with `cx.quit()` would risk false
  success. This residual Desloppify finding is temporarily deferred with evidence,
  not marked fixed or false-positive.

`6d8eba1` preserves `AppError` in send-preview and delivery outcomes instead of
reducing errors to strings at the engine boundary. Clone regressions verify both
application codes and non-default exit statuses, including redacted underlying
errors. Existing native preview, partial-success, changed-review, collision and
rendered-workspace tests pass with unchanged user-visible reasons.

After rescanning and running `next`, `885f14b` follows the next state-boundary
finding: reader-shelf and metadata-save failures now remain typed until sidebar,
editor or snapshot presentation. Native state tests exercise per-reader and
whole-request failures retaining status 74, and a blocked metadata save verifies
no database write with the unchanged busy message. The actual editor test checks
the exact missing-book message, retained draft and editable fields after failure.
All 241 native tests, strict workspace Clippy and snapshot-feature compilation
pass for this slice. Synthetic reader directories do not establish physical-reader
compatibility.

## Store decomposition

`1d5ba62` separates private query compilation, bulk hydration, duplicate discovery
and transactional review/merge, metadata normalization, custom-column definitions,
and current-schema creation. Public store types retain their original import paths
through explicit reexports. Transaction boundaries, rollback, file ownership,
cache invalidation and SQL predicates are unchanged.

The root shrank from **5,073 to 2,618 lines**. A read-only AST comparison found
137 of its 139 original function bodies token-identical across the new subtree.
The other two are relocated duplicate-merge rollback tests whose multiline SQL
strings changed only indentation. The standalone migration byte comparison uses
an unambiguous slice dereference, preserving the original assertion. The new
duplicate test file has an explicit test-zone classification, not an exclusion.

The structural finding remains open: the rescan reports root complexity **604**,
down from **1,008**, but import/file lifecycle, mutations, saved views and their
tests still make the root large. This is a tested architectural improvement, not
a claim that moving code automatically finishes all structural work.

## Final checkpoint: November 3, 21:23 UTC

- `CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh` passes after the
  final code commit. **529 Rust tests pass**, with three existing ignored tests:
  288 engine/CLI tests and 241 native tests. Formatting and strict workspace
  all-target Clippy pass. The release binary is **11,927,744 bytes**, below the
  unchanged 12,000,000-byte limit. Bundle-verifier and release-script self-tests
  pass. These self-tests are not distribution signing or notarization.
- Standalone `cargo test --offline -p takio` passes, covering the feature graph
  that exposed the migration-test ambiguity. `cargo doc --offline -p takio
  --no-deps` and native snapshot-feature compilation pass. The pre-existing
  dependency future-incompatibility notice for `block 0.1.6` remains.
- All retained TypeScript packages passed typechecks and **216 Bun tests**:
  core 38, epub-transform 3, library-contract 41, library-store-bun 134. They were
  not modified. This is not a separate TypeScript Desloppify assessment.
- The final release executable passes `scripts/bench-desktop-native.sh
  --interactions` in five real GUI processes against a disposable 10,000-book
  catalogue, with 100 correct state interactions. Median paint/query/RSS are
  92.643 ms / 147.556 ms / 125,808 KiB. Matching/clearing search settlement p95
  is 62.766 / 27.473 ms, sort dispatch p95 0.157 ms, and select-all/reload
  settlement p95 8.315 ms. These are state-to-notification timings including
  debounce, not physical input-to-paint, scrolling or reader compatibility.

Final logs are under `$JCODE_SCRATCH_DIR`:
`takio-desloppify-native-final.log`, `takio-desloppify-cli-gate.log`,
`takio-desloppify-scan-final.log`, and `takio-desloppify-interactions-final.log`.

### Score and remaining work

The fresh Rust scan reports **strict 21.9/100**, below the initial **22.1**.
The configured 85 target has **not** been reached. Do not describe this as a
strict-score improvement. New/moved modules change detector findings and checks;
tested source improvements are not equivalent to a higher aggregate score.
Twenty subjective dimensions remain unassessed, accounting for the unfilled
75% subjective scoring pool. No invented assessments or blanket suppressions
were imported.

Two mid-cycle rescans used the tool's explicit `--force-rescan` attestation to
refresh findings after substantial moves and subsequent typed-state fixes, while
leaving incomplete work open. The tool reports 316 queued items and 21 temporary
deferrals, and labels the score frozen pending queue completion. No claim is made
that the living plan is drained. Automatic language selection attempted JavaScript
on one rescan, so the successful comparative scans explicitly use `--lang rust`.

Resume with:

```sh
desloppify --lang rust next
```

At this checkpoint the next item is
`smells::apps/cli/src/cli.rs::string_error`. The store structural finding is also
still open. Read actual code and validate changes before resolving either.
No work is scheduled beyond this session, no commits are pushed, and no personal
book library or physical reader was modified.

## Second iteration: November 4, 10:31 UTC

### Blind subjective review

Twenty context-isolated headless reviewers (Read/Grep/Glob only, one dimension
each, five concurrent) scored the blind packet. They had no score history or
targets, and the working tree stayed clean. Importing run `20261103_212808`
moved strict from **21.9** to **79.0**. That jump is the first assessment of the
75% subjective pool, not a code change. It also queued 115 review findings.

### Remediation

All 116 review work items (115 findings plus one carried detector item) were
fixed across 33 local commits (`ed111fd..80fe065`). Each was resolved only after
checking its commit, its regression tests and the code. `desloppify plan resolve`
exits 0 even when it rejects a resolution (queue order, notes under 50
characters), so every resolution was also confirmed in `state-rust.json`.
Highlights:

- Data safety: `library remove` now trashes instead of deleting, and permanent
  deletion only purges trashed items. Committed destructive operations report
  `cleanupPending` paths instead of failing after commit. Cover cleanup checks
  references. Duplicate move imports preserve the source. Single-file imports
  refuse files inside library-owned paths (`d75896d`, which was reproduced
  against the real CLI before the fix).
- Honest outcomes: a verified delivery with a failed manifest update is reported
  as delivered. Batch trash/restore/purge attempt every item and report each one.
  SSH transport failures are distinct from file collisions, and fake ssh/scp
  protocol tests are not a physical Kindle compatibility claim.
- Shared rules: one author policy, one facet/filter implementation, one send
  plan with trash eligibility, and one store-level import overlap guard, used by
  the CLI, TUI and desktop.
- Structure: the engine is split into `apps/engine` (`takio-engine`, lib
  `takio`), so the desktop no longer links clap, ratatui or tiny_http. Engine
  modules are grouped by domain. `cli.rs` went from 4147 to 2840 lines.
  Desktop modules follow the filesystem, `LibraryState` fields are private, and
  activities are one enum. Startup, switch and recovery share one activation
  path.
- Types: explicit store open modes (read-only commands neither create nor
  migrate), `ImportMode`/`Provenance`/overwrite policies instead of positional
  bools, one `Fingerprint`, closed-set enums with unchanged wire JSON, and a typed
  `ErrorCode` (82 variants, identical wire strings) whose native messages match
  exhaustively with no wildcard.

One detector item stays as attested wontfix: desktop `fatal()` for opt-in
acceptance probes. GPUI's macOS quit calls Cocoa `terminate:` and never returns,
so an error return would lose the probe's failure status. Production startup
returns `ExitCode` (`50765e5`).

### Validation on the integrated tree

- `cargo fmt --all --check`, strict workspace Clippy, and
  `cargo test --offline --workspace`: 604 passed, 3 pre-existing ignored,
  0 failed, plus a compile-fail doctest for unknown error codes.
- `CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh` and
  `bash scripts/test-release-scripts.sh` pass.
- `cargo tree --offline -p takio-desktop -e normal` contains no clap, ratatui
  or tiny_http.
- `scripts/bench-desktop-native.sh --interactions` on a disposable 10,000-book
  library: median first paint 86.6 ms, first query 146.6 ms, search p95 35 ms,
  sort p95 2.0 ms, select-all reload p95 9.0 ms, and all interactions correct.
  Startup and interaction budgets pass.
- The real `takio` CLI was exercised on scratch libraries for each data-safety
  change above, including a missing-database `library list` that creates nothing.

### Second blind review and score

A fresh blind review of the changed code (run `20261104_101352`) raised 14 of 20
dimensions. The largest gains were abstraction fitness 74 to 81, package
organization 66 to 74, cross-module architecture 73.5 to 79, and API surface 70
to 74. Convention outlier, logic clarity, naming and AI-generated debt dropped by
1 to 2 points. The first pass scored abstraction fitness at exactly the 85
target, which the tool flags as a gaming risk, so it was rerun blind and scored
81.0. **Strict is 81.4**, against the 85 target, which is **not yet reached**.
The second review queued 116 new, smaller findings, led by type safety (9),
error consistency, mid-level elegance, API surface and design coherence (8
each).

Resume with `desloppify next`. Resolve only verified fixes in plan order, and
check `state-rust.json` after each resolution.
