# Packet 008 — CLI JSON Library Storage Smoke Path

**Horizon:** Foundation — Durable Local Library Storage

**Objective:** Expose the smallest agent-safe CLI proof that the integrated Bun durable store can add one library item and list it from the same caller-supplied database across separate CLI invocations.

## Existing integration facts

- The CLI uses Commander through `createProgram(write)` and tests commands by creating a fresh program and calling `parseAsync` with captured output.
- `@takio/library-store-bun` exports `BunSqliteLibraryStore`, whose constructor requires a nonempty database path, implements the existing async contract, opens with `open({ config: {} })`, and supports `add`, `list`, and `close`.
- The store validates persisted values using the core `LibraryItem` schema and emits existing stable contract error codes.
- The store package's standalone build already restores the core and contract dependency closure before emitting its declared JS and `.d.ts` artifacts.

## Scope

**In scope**

- Add `@takio/library-store-bun` as the CLI's workspace dependency and make only the required workspace-lock registration update.
- Add a minimal `library` command group with exactly two non-interactive subcommands:
  - `takio library add --db <path> --id <id> --title <title> --source-path <path> --format <format> --added-at <ISO-8601>`
  - `takio library list --db <path>`
- Require `--db <path>` for both commands. The caller supplies the database location every time.
- Open the reusable Bun store, run the requested operation, and close it before command completion.
- Emit only stable JSON objects on stdout for these two commands:
  - add success: `{ "ok": true, "value": { "item": LibraryItem } }`
  - list success: `{ "ok": true, "value": { "items": LibraryItem[] } }`
  - store/validation/usage failure: `{ "ok": false, "error": { "code": string } }`
- Add focused CLI tests using a temporary caller-supplied database path. The tests must invoke `library add` and `library list` through separate fresh CLI program invocations, then assert the parsed JSON envelopes and durable listed item.
- Add narrowly scoped CLI error tests for a missing `--db` and a duplicate add, asserting machine-readable error objects and nonzero failure behavior.
- Make the minimum CLI build orchestration change needed for a clean CLI build to restore the core/contract/adapter dependency closure before emitting `apps/cli/dist/main.js`.

**Out of scope**

- Any default or production data path, platform-directory discovery, environment configuration, generic config file, or persistence setting.
- Desktop/Tauri/Rust work, interactive UI, prompts, tables, or human-readable output for the new storage commands.
- Changes to `@takio/core`, `@takio/library-contract`, or `@takio/library-store-bun` APIs, schema version, initialization behavior, migrations, or adapter tests.
- Importer, search, metadata, covers, tags, collections, sync, conversion, queues, devices, cloud, authentication, or unrelated cleanup.
- External dependencies; only the required `bun.lock` workspace registration for the existing workspace package is permitted.

## Required behavior

1. Both new commands require explicit `--db <path>` and never select a path implicitly.
2. `library add` converts its required flags into the existing `LibraryItem` shape, calls the Bun store, and emits one JSON envelope only.
3. `library list` opens the same explicit path on a later fresh invocation and emits the durable items in one JSON envelope only.
4. The CLI preserves stable existing store error codes without leaking SQLite exception messages, stack traces, or Commander prose into JSON output.
5. Missing/invalid command input and store failures use the documented `{ ok: false, error: { code } }` JSON shape and exit nonzero.
6. Each command closes its store in a `finally`-equivalent path, including failure paths.
7. Existing CLI commands retain their current behavior.
8. The CLI clean build regenerates core, contract, adapter declarations and the CLI executable artifact from no generated artifacts.

## Acceptance criteria

- The two commands above are the only new CLI surface.
- The CLI has `@takio/library-store-bun` as a workspace dependency; no external dependency is added.
- Tests use temporary directories and explicit database paths. They run add and list as separate fresh program invocations and parse stdout as JSON.
- The add/list test proves a single item survives between invocations and appears in the list success envelope.
- Error tests prove missing `--db` and duplicate ID failures are JSON-only, stable, and nonzero.
- No new command accepts an implicit/default path or an interactive input path.
- The clean core/contract/adapter/CLI artifact gate succeeds exactly:

```bash
bun install --frozen-lockfile
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

- Exact transcript of two separate CLI invocations against one temporary explicit database path: add then list.
- Parsed JSON output for success and error cases, with no mixed prose on stdout.
- Evidence that the CLI closes each store before temporary-path cleanup.
- Exact frozen-install, clean-artifact build, and workspace-gate output.
- A focused diff review confirming no desktop/Tauri, default-path, schema/migration, generic-config, interactive UI, importer/search/metadata/sync/conversion, or unrelated change.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
feat(cli): add JSON library storage smoke path
```

The commit must contain only this packet's CLI implementation/tests, strictly necessary workspace metadata and lock registration, and clean-build orchestration. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The new CLI commands require caller-supplied paths and create no default user data or migration, so rollback removes only the agent-facing smoke surface.
