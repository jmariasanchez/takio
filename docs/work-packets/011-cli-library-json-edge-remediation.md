# Packet 011 — CLI Library JSON Edge Remediation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Final integration review found that Commander-controlled nested library help and unknown-subcommand paths can bypass Packet 008's JSON protocol and emit Commander prose instead.

**Objective:** Normalize only the unmerged CLI library command group's nested help and unknown-subcommand paths into the existing agent-safe JSON failure protocol.

## Scope

**In scope**

- The current unmerged `library` command group implementation in `apps/cli/src/main.ts` and its focused CLI tests only.
- Handling `takio library list --help` and unknown nested commands such as `takio library nope`.
- Emitting exactly one stable single-line JSON failure object on stdout for both paths, using the documented `invalid-arguments` error code.
- Setting a nonzero exit status for both paths.
- Focused tests that assert exactly one captured stdout write, absence of `\n` and `\r`, successful `JSON.parse`, the structured error envelope, no Commander prose, and nonzero behavior.

**Out of scope**

- Any change to normal `library add` or `library list` success semantics, their caller-required `--db <path>` behavior, or no-default-path policy.
- Dependencies, `bun.lock`, workspace metadata, package configuration, or build-script changes.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, database/storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, generic configuration, interactive UI, importer/search/metadata/sync/conversion features, or unrelated behavior/files.

## Required behavior

1. `takio library list --help` emits exactly one stdout record:

```json
{"ok":false,"error":{"code":"invalid-arguments"}}
```

It contains no Commander usage/help/prose output and exits nonzero.

2. `takio library nope` emits exactly the same stable single-line JSON failure object, contains no Commander prose, and exits nonzero.
3. The library group continues to emit the Packet 008 success envelopes for valid add/list commands and continues to require caller-supplied `--db <path>`.
4. The Packet 009/010 test protocol remains in force: exactly one captured write; no `\n` or `\r`; parse the unchanged physical line with `JSON.parse`; then assert the structured envelope.
5. The remediation does not change behavior of unrelated top-level commands.

## Acceptance criteria

- Only the unmerged CLI library command group and focused CLI tests change.
- Both specified Commander edge paths yield one physical JSON line on stdout, parse to `{ ok: false, error: { code: "invalid-arguments" } }`, and have nonzero exit behavior.
- Tests explicitly verify no Commander prose is captured for either edge path.
- Existing add/list success tests and explicit no-default-path behavior remain covered and unchanged.
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

- Exact focused-test output for `library list --help` and `library nope`.
- Evidence of exactly one captured write, no `\n`/`\r`, successful `JSON.parse`, `invalid-arguments`, no Commander prose, and nonzero behavior for each path.
- Evidence that valid add/list success and caller-required `--db` behavior remain unchanged.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the allowed unmerged CLI group/tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(cli): normalize library command errors
```

The commit must contain only this CLI command-group/test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only the unmerged library command group's error handling and focused tests; no database/default-path state changes.
