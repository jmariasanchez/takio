# Packet 010 — CLI JSON Physical-Line Test Remediation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 009's exact-one-write assertion does not prove that the captured output is physically one JSON line: a single captured string can still contain embedded line-feed or carriage-return characters.

**Objective:** Strengthen only the unmerged CLI focused test helper so it rejects any captured JSON output containing `\n` or `\r` before `JSON.parse`, while preserving Packet 009's exactly-one-write, parsed-envelope, and nonzero-error assertions.

## Scope

**In scope**

- The current unmerged Packet 008/009 CLI focused test helper only.
- A helper assertion that the single captured stdout string contains neither `\n` nor `\r` before that exact string is passed to `JSON.parse`.
- Reuse of that helper for all library-command success and error test paths.

**Out of scope**

- Any CLI runtime behavior, command surface, output serialization, error mapping, or process-exit change.
- Dependencies, `bun.lock`, workspace metadata, package configuration, or build-script changes.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, interactive UI, generic configuration, importer/search/metadata/sync/conversion features, or unrelated files.

## Required behavior

1. Before `JSON.parse`, the focused test helper asserts exactly one captured stdout write.
2. It then asserts the one captured string contains neither line-feed (`\n`) nor carriage-return (`\r`) characters.
3. It parses that unchanged physical line with `JSON.parse` and returns/asserts the structured envelope.
4. All Packet 008 success and error tests continue to use the helper, assert their parsed JSON envelopes, and retain explicit nonzero error-path checks.
5. A newline-containing single captured string must fail the physical-line assertion before JSON parsing.
6. No production code, CLI behavior, dependency/build state, or non-test artifact changes.

## Acceptance criteria

- Only the unmerged CLI focused test helper/test file changes.
- The helper preserves exact-one-write checking and adds explicit `\n` and `\r` absence checks before `JSON.parse`.
- Add/list success and missing-`--db`/duplicate-add error tests all continue to parse the physical output line and assert their structured envelopes.
- Nonzero failure behavior remains explicitly asserted.
- No runtime, command, dependency, lockfile, workspace/build, adapter/core/contract, storage/schema/default-path, desktop/Tauri, or unrelated change appears in the diff.
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

- Focused-test evidence that the helper asserts one write and absence of both `\n` and `\r` before `JSON.parse`.
- Parsed success/error envelope evidence and retained nonzero-error evidence.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the unmerged CLI focused tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
test(cli): require single-line library JSON
```

The commit must contain only this focused test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only tests and leaves all runtime behavior unchanged.
