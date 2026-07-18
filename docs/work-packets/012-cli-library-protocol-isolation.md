# Packet 012 — CLI Library Protocol Isolation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 011's library JSON normalization can accidentally configure Commander output/error handling at a scope that suppresses established stderr/prose behavior for unrelated top-level commands. Its no-prose tests also need real-process stdout/stderr evidence, and temporary database fixture teardown must be scoped and failure-safe.

**Objective:** Isolate the unmerged library command group's JSON error protocol from existing top-level Commander behavior, strengthen its edge-path tests with real process streams, and make only storage-test fixture lifecycle cleanup failure-safe.

## Scope

**In scope**

- The current unmerged CLI library error-protocol implementation in `apps/cli/src/main.ts` and focused CLI tests only.
- Commander output/error configuration confined to the library command group or its explicit execution boundary, so it cannot suppress pre-existing top-level command diagnostics.
- Real-process focused tests for `takio library list --help` and `takio library nope`, capturing stdout, stderr, and exit status.
- Regression tests proving pre-existing top-level invalid `takio plan` behavior and unknown top-level-command behavior retain their expected stderr/prose diagnostics and nonzero exits.
- Temporary database fixture setup/cleanup limited to tests that actually exercise storage. Fixture state must be initialized before setup can fail, cleanup must guard optional resources, close handles before deletion, and avoid teardown failures masking the original failure.

**Out of scope**

- Any change to command names/options/surface; normal add/list success semantics; caller-required `--db <path>`; or the no-default-path policy.
- Dependencies, `bun.lock`, workspace metadata, package configuration, or build-script changes.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, database/storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, generic configuration, interactive UI, importer/search/metadata/sync/conversion features, or unrelated behavior/files.

## Required behavior

1. The library-specific JSON protocol remains limited to library paths. It must not globally redirect/suppress Commander output or error streams for unrelated top-level commands.
2. In a real spawned process, `takio library list --help` produces:
   - stdout: exactly one physical line with no `\n` or `\r` embedded in the captured record, parsing to `{ ok: false, error: { code: "invalid-arguments" } }`;
   - stderr: empty;
   - exit status: nonzero.
3. In a real spawned process, `takio library nope` meets the identical stdout, stderr, parsed-envelope, and nonzero requirements.
4. Real-process regression tests prove an invalid top-level `takio plan` and an unknown top-level command retain their pre-existing nonzero behavior and Commander stderr/prose diagnostics; the library protocol must not convert those top-level paths to library JSON or silence stderr.
5. Valid add/list success behavior and explicit caller `--db <path>` behavior remain unchanged.
6. Temporary directory/database lifecycle setup occurs only in storage tests. Teardown is guarded if setup fails, attempts required closes before deletion, and does not create unrelated test fixtures for help/error-only tests.

## Acceptance criteria

- Changes are limited to the unmerged library error protocol and focused CLI tests.
- Library help and unknown-child tests use real spawned processes, not only an injected `write` callback.
- Both library edge paths assert stdout one-write/physical-line characteristics, empty stderr, `JSON.parse`, the exact `invalid-arguments` envelope, and nonzero status.
- Top-level invalid-plan and unknown-command regression tests prove established stderr/prose and nonzero behavior remain intact.
- Storage-only fixtures use failure-safe setup/cleanup; help/error-only tests do not create temporary databases.
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

- Real-process stdout/stderr/status transcripts for both library edge paths.
- Parsed physical-single-line JSON and empty-stderr assertions for both paths.
- Top-level invalid-plan and unknown-command regression evidence proving existing stderr/prose remains intact.
- Storage-only, failure-safe fixture cleanup evidence.
- Valid add/list and explicit-path preservation evidence.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the allowed unmerged CLI protocol/tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(cli): isolate library error protocol
```

The commit must contain only this library-protocol/test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only unmerged CLI error-protocol isolation and focused tests; it creates no default storage or database migration.
