# Packet 007 — Bun Store Initialization Atomicity

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 006's version-0 schema preflight is vulnerable to a time-of-check/time-of-use race: a second SQLite connection could create a non-internal schema object after inspection but before Takio creates its v1 schema and stamps `PRAGMA user_version`.

**Objective:** Make only the unmerged Bun SQLite adapter's version-0 initialization sequence atomic against concurrent schema writers, and prove that safety with a deterministic two-connection regression test.

## Scope

**In scope**

- The current unmerged `packages/library-store-bun` adapter implementation and its focused tests only.
- One lock-protected, immediate SQLite transaction for first-time version-0 initialization.
- Serialization, within that same transaction, of the version read, non-internal schema-object preflight, v1 Takio table DDL, and `PRAGMA user_version = 1` stamp.
- A deterministic two-connection regression test proving a competing connection cannot inject a non-internal schema object between preflight and Takio initialization.
- The existing version-0 non-mutation rejection behavior for a pre-existing non-internal schema object.

**Out of scope**

- Changes to `@takio/library-contract`, `@takio/core`, public APIs, contract result shapes, error-code definitions, or the schema version: initial schema remains version `1`.
- CLI integration, Tauri/Rust/desktop work, production default paths, environment configuration, or user-data location discovery.
- Migrations, downgrade support, backup/repair tooling, later-schema handling, or any schema work beyond atomic initialization of the existing v1 schema.
- External dependencies, lockfile changes, SQLite wrappers/ORMs, retries/background coordination, or unrelated product, build, formatting, or documentation changes.

## Required behavior

1. For a database with `PRAGMA user_version = 0`, acquire an immediate SQLite write lock before reading the version or inspecting schema objects.
2. In one transaction protected by that lock, perform in order: read `user_version`; inspect `sqlite_schema` for any non-`sqlite_%` object; create the existing v1 Takio schema only if the database is empty; then stamp `PRAGMA user_version = 1`; commit.
3. If the version-0 preflight finds a non-internal schema object, roll back and return exactly the existing failure `{ ok: false, error: { code: "incompatible-schema" } }`.
4. This rejection remains non-mutating: no Takio table/index/trigger/view is created and `PRAGMA user_version` remains `0`.
5. If initialization fails or a competing connection cannot acquire a compatible lock, no partial Takio schema/version stamp is committed.
6. A deterministic two-connection test must coordinate the initialization attempt and a competing schema-write attempt without timing sleeps or best-effort polling. It must prove that the competitor cannot create a non-internal schema object in the interval between the adapter's version/schema preflight and its v1 DDL/version stamp.
7. The regression test must demonstrate that no unsafe interleaving can cause Takio to stamp a database that became unexpectedly nonempty while it was still version `0`.
8. Existing empty-database initialization to v1 and Packet 006's lifecycle-cleanup guarantees remain intact.

## Acceptance criteria

- The adapter uses an immediate transaction or equivalent SQLite lock-protected single initialization sequence; the version read, schema inspection, DDL, and version stamp are not split across independently commit-able operations.
- A version-0 database containing a pre-existing non-internal schema object still returns the exact `incompatible-schema` result and is unchanged after rejection.
- The deterministic two-connection regression test uses explicit synchronization or a narrowly scoped non-public test seam where necessary; it must not rely on sleeps, probabilistic scheduling, or a public API/contract change.
- The test proves the competing connection cannot inject a schema object between preflight and initialization; it also verifies no partial/stamped unsafe version-0 state results.
- The remediation is limited to the unmerged adapter and focused tests.
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

- The exact deterministic two-connection test transcript and its synchronization strategy.
- Evidence that version read, preflight, v1 DDL, and version stamp execute under one immediate transaction/lock-protected sequence.
- Evidence that a pre-existing non-internal version-0 database still produces `incompatible-schema` without mutation.
- Exact output from the clean dependency-closure build and all workspace gates.
- A focused diff review confirming no contract/API/schema-v1, CLI/Tauri/default-path/migration/dependency, or unrelated change.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(storage): serialize Bun store initialization
```

The commit must contain only this remediation's adapter and focused test changes. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The remediation creates no migration and changes no public API; rollback restores only the prior unmerged initialization behavior.
