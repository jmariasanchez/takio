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
# After resolving the active implementation queue:
desloppify scan --path .
desloppify next
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
