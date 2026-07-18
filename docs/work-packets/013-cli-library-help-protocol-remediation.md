# Packet 013 — CLI Library Help Protocol Remediation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 012 covers a subset of nested Commander help/error paths, but library-owned help routes can still bypass the JSON error protocol.

**Objective:** Normalize every specified unmerged library-owned help route into the same isolated agent-safe JSON failure protocol without changing root/top-level help or established top-level diagnostics.

## Scope

**In scope**

- The current unmerged library command-group implementation in `apps/cli/src/main.ts` and focused CLI real-process tests only.
- Normalization of exactly these library-owned help routes:
  - `takio library --help`
  - `takio library add --help`
  - `takio library help add`
  - `takio library help list`
- Real-process stdout/stderr/exit/physical-line/parsed-JSON tests for every listed route.
- Narrow command-group wiring needed to ensure the library group's help handling is isolated from root/top-level Commander behavior.

**Out of scope**

- Root/top-level help semantics or the established stderr/prose diagnostics for top-level invalid-plan and unknown-command paths.
- Any command names/options/surface; normal add/list success semantics; caller-required `--db <path>`; or the no-default-path policy.
- Dependencies, `bun.lock`, workspace metadata, package configuration, or build-script changes.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, database/storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, generic configuration, interactive UI, importer/search/metadata/sync/conversion features, or unrelated behavior/files.

## Required behavior

1. Every listed library-owned help route emits exactly this one physical stdout JSON failure line, with no `\n` or `\r` characters:

```json
{"ok":false,"error":{"code":"invalid-arguments"}}
```

2. For every listed route, stderr is empty and exit status is nonzero.
3. Each raw stdout result parses unchanged with `JSON.parse` to `{ ok: false, error: { code: "invalid-arguments" } }`.
4. No Commander usage/help/prose is emitted for the listed library-owned help routes.
5. Root/top-level help behavior remains normal and unchanged; Packet 012's top-level invalid-plan and unknown-command stderr/prose diagnostics remain intact.
6. Valid library add/list commands and their explicit `--db <path>` requirement remain unchanged.

## Acceptance criteria

- The implementation and tests are limited to the unmerged library command group and focused CLI tests.
- All four listed help routes are tested in real spawned processes, with captured stdout, stderr, and exit status.
- Every test asserts exact one-record physical stdout (no `\n`/`\r`), empty stderr, successful `JSON.parse`, the exact `invalid-arguments` envelope, no Commander prose, and a nonzero exit.
- Regression evidence shows root/top-level help and prior top-level error diagnostics remain unchanged.
- Existing add/list success and caller-required explicit-path behavior remain covered.
- No dependency, lockfile, workspace/build, adapter/core/contract, database/schema/default-path, desktop/Tauri, or unrelated change appears in the diff.
- The clean core/contract/adapter/CLI artifact gate succeeds exactly:

```bash
rm -rf packages/core/dist packages/library-contract/dist packages/library-store-bun/dist apps/cli/dist
bun run --filter '@takio/cli' build
test -f packages/core/dist/index.js
test -f packages/core/dist/index.d.ts
test -f packages/library-contract/dist/index.js
test -f packages/library-contract/dist/index.d.ts
test -f packages/library-store-bun/dist/index.js
test -f packages/library-store-bun/dist/index.d.ts
test -f apps/cli/dist/main.js
```

- The full workspace gates pass after the clean artifact build:

```bash
bun run --filter '@takio/cli' check
bun run --filter '@takio/cli' test
bun run check
bun run test
bun run build
git diff --check
```

## Required evidence

- Real-process stdout/stderr/exit transcripts for all four listed library help routes.
- Physical-single-line, parsed-JSON, `invalid-arguments`, empty-stderr, no-prose, and nonzero assertions for every route.
- Regression evidence that root/top-level help and prior top-level diagnostics remain intact.
- Valid add/list and explicit-path preservation evidence.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the allowed unmerged CLI group/tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(cli): normalize library help protocol
```

The commit must contain only this library-help protocol/test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only unmerged library help handling and focused tests; it creates no storage/default-path state or migration.
