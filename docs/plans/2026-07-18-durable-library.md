# Takio Durable Library Plan

> Drafted with Claude Code using `claude-fable-5` on 2026-07-18, then grounded against the current repository.

**Goal:** Turn the existing schema-v1 SQLite store and CLI smoke path into a safe, useful local library without adding Calibre-scale features.

## Current state

- `@takio/core` owns the validated `LibraryItem`: `id`, `title`, `sourcePath`, `format`, and `addedAt`.
- `@takio/library-contract` defines JSON-safe asynchronous `open`, `list`, `get`, `add`, and `remove` operations with driver-independent errors.
- `@takio/library-store-bun` implements that contract with Bun SQLite, a strict version-1 schema, locked initialization, row revalidation, and close/reopen tests.
- The CLI exposes `library add` and `library list`, but callers must choose the database path and `add` records a path without importing the file.

## Non-goals

Desktop UI, metadata/covers/tags/search, conversion, queues, devices, viewer/editor/server features, plugins, collections, cloud storage, an ORM, and new dependencies.

## Phase 1 — Own the production data location

**Depends on:** the existing v1 store.

**Likely files:** `apps/cli/src/main.ts`, a small path helper beside it, and focused CLI tests.

- Resolve one platform-appropriate Takio data directory with a test-only environment override; keep `--db` as an explicit override for agents and tests.
- Put `library.sqlite` and an `items/` directory under that root. Create directories only when a command needs storage.
- Never derive a writable path from document metadata or a webview argument.

**Success criteria:** `takio library list` works without `--db`; the override relocates all state into a temporary directory; tests never read or write the real user data directory; existing explicit-path behavior remains compatible.

## Phase 2 — Import files Takio can safely retain

**Depends on:** Phase 1.

**Likely files:** `apps/cli/src/main.ts`, `apps/cli/test/main.test.ts`, and only if needed a single import helper beside the CLI.

- Add `library import --source-path <path> [--title <title>]` as the user-facing path. Validate that the source is a regular file, detect a supported format with `@takio/core`, generate the ID and timestamp, copy to a temporary file under `items/`, then rename to the final generated name before adding the row.
- Store the owned file path in the existing `sourcePath` field. The original remains untouched and can disappear after import.
- On validation, copy, or database failure, remove only the temporary/owned file created by that invocation. Never delete a caller path.
- Preserve low-level `library add` for deterministic agent fixtures; do not silently change its meaning to file ownership.

**Success criteria:** deleting the original after import does not break the stored item; unsupported, missing, and non-file sources fail before a row is added; a duplicate or failed insert leaves no final file created by that invocation; no shell command is built from a path.

## Phase 3 — Complete the existing contract at the CLI

**Depends on:** Phase 2 so removal can distinguish owned files.

**Likely files:** `apps/cli/src/main.ts`, `apps/cli/test/main.test.ts`.

- Expose `library get` and `library remove` through the already-implemented store methods.
- Return the existing successful `null` for a missing record rather than inventing a new error.
- After a successful row removal, delete a file only when its canonical path is inside Takio's `items/` directory. A row created by low-level `add` may point elsewhere and must never authorize file deletion.
- Keep every nested library result or failure as exactly one JSON record with a truthful exit status.

**Success criteria:** separate CLI invocations prove `import → list → get → remove → get`; a second remove is a successful `null`; removing a low-level record never deletes its external source; an owned-file deletion failure is reported and tested rather than hidden.

## Migration and recovery gate

Do not build a generic migration framework before a second schema exists. The first schema-changing capability must land its `v1 → v2` migration with these checks:

- Read `PRAGMA user_version` under the existing immediate transaction; refuse an unknown newer version without mutation.
- Copy a consistent pre-migration database backup beside the production database before changing it. Do not back up an open WAL by copying only its main file; use SQLite's supported backup mechanism or checkpoint and close first.
- Run the migration transactionally, update `user_version` last, and retain the pre-migration backup until the upgraded database passes `PRAGMA integrity_check` and domain revalidation.
- Recovery is initially explicit: close Takio, preserve the failed database, and atomically restore the verified backup. Defer backup rotation, repair UI, and down-migrations until real operational need exists.

**Success criteria for the first migration:** a frozen v1 fixture upgrades without changing existing values; an injected migration failure leaves v1 readable; a future-version database remains byte-for-byte unchanged; the backup opens independently and passes integrity checking.

## Verification

```bash
bun run --filter '@takio/core' test
bun run --filter '@takio/library-contract' test
bun run --filter '@takio/library-store-bun' test
bun run --filter '@takio/cli' check
bun run --filter '@takio/cli' test
bun run check
bun run test
bun run build
git diff --check

TAKIO_DATA_DIR="$(mktemp -d)" bun run takio library list
```

The implementation packet must also run an isolated import smoke check using a temporary source and data directory, delete the original, reopen the store, then prove the owned copy remains readable and removal does not touch any external file.

## Rollback

Phases 1 and 3 change no schema and can be reverted without transforming data. Reverting Phase 2 leaves imported files and valid v1 rows intact; report the owned directory for manual recovery rather than deleting it. A future schema change is rolled back by closing the application and restoring its verified pre-migration backup, never by an untested down-migration.
