# Packet 014 — CLI Root Help / Library Regression

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 013's direct-library help normalization risks intercepting Commander root-owned `takio help library ...` traversal, which must retain ordinary help semantics rather than the library JSON error protocol.

**Objective:** Restore and protect root-owned library help traversal while retaining every direct library-owned help/error protocol path normalized by Packets 011–013.

## Scope

**In scope**

- The current unmerged library Commander error-protocol implementation in `apps/cli/src/main.ts` and focused CLI real-process tests only.
- Narrow command-group/root-help routing necessary to distinguish root-owned `help library ...` traversal from direct library-owned help/error routes.
- Real-process tests for exactly these root-owned help routes:
  - `takio help library`
  - `takio help library add`
  - `takio help library list`
- Regression coverage retaining every direct library-owned help/error route normalized by Packet 013.

**Out of scope**

- Any new command names/options/surface; normal add/list success semantics; caller-required `--db <path>`; or the no-default-path policy.
- Dependencies, `bun.lock`, workspace metadata, package configuration, or build-script changes.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, database/storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, generic configuration, interactive UI, importer/search/metadata/sync/conversion features, or unrelated behavior/files.

## Required behavior

1. Each root-owned help route—`takio help library`, `takio help library add`, and `takio help library list`—emits normal Commander help prose on stdout only, has empty stderr, exits with status `0`, and does not emit a JSON error object.
2. Packet 013's direct library-owned help routes remain normalized as JSON failures: `takio library --help`, `takio library add --help`, `takio library help add`, and `takio library help list` must each continue to emit exactly `{"ok":false,"error":{"code":"invalid-arguments"}}` as one physical stdout record, with empty stderr and a nonzero exit.
3. Packet 011/012's direct library error handling, including unknown nested commands and the `library list --help` path, remains agent-safe JSON with no prose, empty stderr, and nonzero behavior.
4. Root `takio --help` and established top-level invalid-plan/unknown-command stderr/prose diagnostics remain unchanged.
5. Valid library add/list commands and their explicit caller-supplied `--db <path>` requirement remain unchanged.

## Acceptance criteria

- Only the unmerged library Commander error-protocol implementation and focused CLI tests change.
- Real-process tests for all three root-owned help routes assert: stdout contains Commander help prose, stderr is empty, exit is `0`, and stdout is not a JSON error envelope.
- Regression tests prove all direct library-owned Packet 013 help routes retain one physical JSON stdout record, empty stderr, parsed `invalid-arguments`, no Commander prose, and nonzero exits.
- Tests retain Packet 011/012 library error-protocol coverage and top-level/root help diagnostic preservation.
- Existing add/list success and explicit-path behavior remain covered.
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

- Real-process stdout/stderr/exit transcripts for all three root-owned help routes.
- Evidence of Commander prose on stdout only, status `0`, and absence of JSON error output for each.
- Regression evidence for every Packet 013 direct library help route and the prior direct library error paths.
- Root `--help`, top-level error, valid add/list, and explicit-path preservation evidence.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the allowed unmerged CLI protocol/tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(cli): preserve root library help
```

The commit must contain only this library-protocol/test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only unmerged Commander help/error routing and focused tests; it creates no storage/default-path state or migration.
