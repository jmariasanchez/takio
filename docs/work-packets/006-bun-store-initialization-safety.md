# Packet 006 — Bun Library Store Integrity and Cleanup Remediation

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 005 quality review found two correctness defects in the unmerged `@takio/library-store-bun` adapter: unsafe initialization of a nonempty version-0 database and test cleanup that can leave adapter connections open after a failed assertion.

**Objective:** Harden only the unmerged Bun SQLite adapter and its tests so unsafe version-0 databases are rejected without mutation and every test-created adapter is closed reliably.

## Scope

**In scope**

- The current unmerged `packages/library-store-bun` adapter implementation and its focused tests only.
- Version-0 database initialization preflight that detects any pre-existing non-internal SQLite schema object before Takio initialization.
- Return the existing `incompatible-schema` contract error for that unsafe pre-existing-schema case.
- Test fixtures and lifecycle helpers needed to ensure every adapter instance is closed in a `finally` path, including when an assertion throws.
- Focused regression tests for both required quality-review findings.

**Out of scope**

- Changes to `@takio/library-contract`, `@takio/core`, their public APIs, contract result shapes, error-code definitions, or schema-version semantics.
- Any schema-version change: initial Takio schema remains version `1` only.
- CLI integration, CLI commands, Tauri/Rust/desktop changes, production default data paths, or environment configuration.
- Migrations, downgrade support, backup/repair tooling, later-schema handling, or changes beyond the initial-v1 initialization behavior.
- External dependencies, lockfile changes, SQLite wrappers/ORMs, or any unrelated product, build, formatting, or documentation change.

## Required behavior

1. On `open`, when `PRAGMA user_version` is `0`, inspect the SQLite schema before creating Takio tables or changing `user_version`.
2. Any pre-existing schema object whose name is not an SQLite internal `sqlite_%` object makes that database unsafe for first-time Takio initialization.
3. For that unsafe version-0 database, `open` returns exactly the existing contract failure `{ ok: false, error: { code: "incompatible-schema" } }`.
4. Rejection is non-mutating: it must not create any Takio table/index/trigger/view, stamp `PRAGMA user_version`, or otherwise claim the database as Takio storage.
5. Empty version-0 database initialization remains unchanged: it creates the existing v1 Takio schema and sets `PRAGMA user_version = 1`.
6. Every adapter instance created by a test is closed in a cleanup path that runs even if an assertion fails. Temporary-directory deletion must occur only after those close attempts.
7. The remediation changes no contract/API/schema-version behavior outside the unsafe version-0 preflight and test-resource cleanup.

## Acceptance criteria

- A focused test creates a temporary SQLite database with `PRAGMA user_version = 0` and a non-internal schema object, such as a caller-owned table.
- Opening that database returns the exact `incompatible-schema` error result.
- The test verifies after rejection that `PRAGMA user_version` remains `0` and no Takio schema object was created or stamped.
- Existing empty-database initialization still succeeds and results in schema version `1`.
- The test suite has a structured `try`/`finally` or equivalent lifecycle mechanism that closes every created adapter instance even after an assertion fails; temporary-directory cleanup follows adapter closure.
- The remediation changes only the unmerged adapter package and its tests.
- The clean declared-artifact dependency-closure gate succeeds exactly:

```bash
rm -rf packages/core/dist packages/library-contract/dist packages/library-store-bun/dist
bun run --filter '@takio/library-store-bun' build
test -f packages/core/dist/index.js
test -f packages/core/dist/index.d.ts
test -f packages/library-contract/dist/index.js
test -f packages/library-contract/dist/index.d.ts
test -f packages/library-store-bun/dist/index.js
test -f packages/library-store-bun/dist/index.d.ts
```

- The full workspace gates pass after the clean dependency-closure build:

```bash
bun run --filter '@takio/library-store-bun' check
bun run --filter '@takio/library-store-bun' test
bun run check
bun run test
bun run build
git diff --check
```

## Required evidence

- Exact focused-test output showing the unsafe version-0 pre-existing-schema rejection and the normal empty initialization path.
- Test evidence that rejection did not stamp version `1` or create a Takio schema object.
- The cleanup strategy and evidence that every created adapter is closed before temporary-directory cleanup.
- Exact output from the dependency-closure build and all workspace gates.
- A focused diff review confirming the contract/API/schema-version, CLI/Tauri/default-path/migration/dependency, and unrelated-feature boundaries were preserved.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(storage): harden Bun store initialization
```

The commit must contain only this remediation's adapter and test changes. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The remediation creates no migration and changes no public API; rollback restores the prior unmerged adapter behavior only.
