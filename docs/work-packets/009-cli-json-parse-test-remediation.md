# Packet 009 — CLI JSON Parse Test Remediation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 008 specification review found that its focused CLI tests must prove actual JSON parseability, not merely compare captured strings or inspect JSON-looking text.

**Objective:** Strengthen only the unmerged Packet 008 CLI focused tests so every JSON storage-command success and error assertion first parses captured stdout with `JSON.parse`, while retaining one-line-output and nonzero-failure checks.

## Scope

**In scope**

- The current unmerged Packet 008 focused CLI test file(s) only.
- Test helpers and assertions required to parse captured stdout with `JSON.parse` for library-command success and error cases.
- Assertions that captured stdout consists of exactly one JSON line before parsing.
- Existing nonzero failure-behavior assertions for the missing-`--db` and duplicate-add error paths.

**Out of scope**

- Any change to CLI runtime behavior, command names/options/surface, output serialization, error mapping, or process exit behavior.
- Changes to CLI dependencies, workspace metadata, `bun.lock`, build scripts, or package configuration.
- Changes to `@takio/library-store-bun`, `@takio/library-contract`, `@takio/core`, adapter/core/contract APIs, storage behavior, schema, migrations, or default paths.
- Desktop/Tauri/Rust work, generic configuration, interactive UI, importer/search/metadata/sync/conversion features, or unrelated code, documentation, or formatting changes.

## Required behavior

1. For the Packet 008 add success case, test code verifies captured stdout has exactly one line, parses that line with `JSON.parse`, and asserts the resulting structured `{ ok: true, value: { item } }` envelope.
2. For the separate-invocation list success case, test code verifies one output line, parses it with `JSON.parse`, and asserts the structured `{ ok: true, value: { items } }` envelope including the durable item.
3. For every Packet 008 library-command error case, including missing `--db` and duplicate add, test code verifies one output line, parses it with `JSON.parse`, and asserts the structured `{ ok: false, error: { code } }` envelope.
4. The existing nonzero failure behavior remains explicitly asserted for each error path.
5. Tests do not loosen expected envelope fields or accept non-JSON text. A JSON-looking string that fails `JSON.parse` must fail the test.
6. No production CLI, store, contract, schema, or build behavior changes.

## Acceptance criteria

- Only unmerged Packet 008 focused CLI test file(s) are changed.
- Every storage-command success and error assertion parses captured stdout via `JSON.parse` before checking fields.
- Every parsed output is preceded by an assertion that exactly one output line was captured; tests do not join multi-line output before parsing.
- The tests retain assertions for nonzero exits on failure cases.
- The existing separate fresh CLI invocation and caller-supplied temporary-path durable round-trip remain covered.
- No runtime, dependency, lockfile, workspace metadata, build, adapter/core/contract, storage/schema/default-path, desktop/Tauri, or unrelated change is included.
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

- Focused test output demonstrating parsed success and error envelopes.
- Reviewable test assertions showing `JSON.parse` is used after exact-one-line checks for every storage command path.
- Evidence that nonzero error-path behavior remains asserted.
- Exact clean-artifact and workspace-gate output.
- A focused diff review proving only the unmerged CLI tests changed.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
test(cli): parse library JSON output
```

The commit must contain only the focused Packet 008 CLI test remediation. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. This remediation changes only tests and leaves all runtime behavior unchanged.
