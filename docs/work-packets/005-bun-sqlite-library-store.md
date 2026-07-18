# Packet 005 — Bun SQLite Durable Library Adapter

**Horizon:** Foundation — Durable Local Library Storage

**Objective:** Add the first real durable local library adapter as `@takio/library-store-bun`, implementing the existing `@takio/library-contract` with Bun's built-in `bun:sqlite` and an explicitly injected database path.

## Prerequisite evidence

Bun 1.3.13 successfully imported `Database` from `bun:sqlite` against a throwaway database outside the repository. It created a table, inserted a row, closed, reopened the same database, read the row, and reported `PRAGMA user_version` as `0` before schema initialization.

## Scope

**In scope**

- Create `packages/library-store-bun` with package metadata, TypeScript configuration, public entrypoint, focused tests, and concise package-local documentation.
- Implement a Bun-only adapter that implements the existing `LibraryStore` contract from `@takio/library-contract`.
- Export an explicit factory/constructor that requires a caller-provided database path; tests must inject temporary database paths.
- Implement adapter lifecycle needed for tests, including explicit close/reopen support outside the base contract.
- Use `Database` from `bun:sqlite` only inside the adapter package.
- Initialize one SQLite schema version only: version `1`.
- Create the minimum v1 table/schema required to durably store the existing `LibraryItem` fields: ID, title, source path, format, and added-at timestamp.
- Implement durable `open`, `add`, `get`, `list`, and `remove` behavior through the existing contract's result/error shapes.
- Add close/reopen tests against injected temporary database paths proving create/add, get, list, and remove behavior persists across adapter instances.
- Add the minimum root workspace-script changes required to build, check, and test the new package.
- Prove a clean dependency-closure build regenerates the declared JS and `.d.ts` artifacts for core, contract, and the new adapter.

**Out of scope**

- CLI commands, CLI integration, JSON smoke commands, or changes under `apps/cli`.
- Tauri commands, Rust code, desktop frontend changes, or changes under `apps/desktop`.
- Production default data paths, platform directory discovery, environment-variable configuration, user settings, or automatic database-path selection.
- Schema migrations beyond initial v1 initialization, downgrade support, backup/repair workflows, or handling data from later schema versions.
- Changes to `@takio/core` or `@takio/library-contract` public APIs, domain behavior, error codes, or tests.
- Any external SQLite dependency, lockfile change, SQLite wrapper, ORM, Bun runtime change outside the new adapter package, or generic multi-driver abstraction.
- Conversion, queue, sync, devices, import, metadata, covers, search, tags, collections, cloud, authentication, or unrelated product features.

## Required behavior

1. The new adapter imports Bun SQLite through `import { Database } from "bun:sqlite"` and implements the existing asynchronous `LibraryStore` contract without changing it.
2. The adapter requires an explicit database path supplied by its caller. It must not choose, create, or document a production default location.
3. `open` initializes an empty database to schema version `1` and makes the v1 storage table available. Reopening an already initialized v1 database is safe and does not change its schema version.
4. A successfully added valid `LibraryItem` remains readable after the adapter is closed and a new adapter instance reopens the same injected database path.
5. `get` returns the stored item by ID and returns the contract's successful `null` value for a missing item.
6. `list` returns the stored library items from the durable database, not process-local memory.
7. `remove` returns the removed stored item; after close/reopen, `get` returns successful `null` for that ID.
8. Persisted rows are revalidated as `LibraryItem` values at the adapter boundary. A duplicate primary-key add maps to the existing `duplicate-id` contract error code; no driver exception text leaks through the contract result.
9. The adapter package emits the JS and declaration entrypoints advertised by its package metadata.

## Acceptance criteria

- The only new product package is `@takio/library-store-bun`.
- Tests use unique temporary directories/database paths supplied to the adapter factory; no test writes into the repository or a real user data directory.
- Tests demonstrate a complete close/reopen durable round trip covering add, get, list, and remove.
- Tests verify initial schema initialization produces `PRAGMA user_version = 1` and reopening retains version `1`.
- The adapter uses no external SQLite dependency and does not modify the contract or core public API.
- The declared-artifact dependency-closure gate succeeds exactly:

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

- The following shared gates pass after the clean dependency-closure build:

```bash
bun run --filter '@takio/library-store-bun' check
bun run --filter '@takio/library-store-bun' test
bun run check
bun run test
bun run build
git diff --check
```

## Required evidence

- Exact output from the clean dependency-closure build and every required gate.
- Test output proving the temporary injected database path round trip across close/reopen.
- Evidence that schema initialization sets and retains version `1`.
- A focused-diff review confirming no CLI, Tauri, production-path, migration, dependency, or unrelated product change.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
feat(storage): add Bun SQLite library store
```

The commit must contain only Packet 005's new adapter package, its tests/documentation, and strictly necessary root workspace-script changes. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The adapter has no production default path and no existing user database migration, so rollback removes the new package without altering prior durable data.
