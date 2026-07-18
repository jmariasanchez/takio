# Packet 003 — Runtime-Neutral Library Contract

**Horizon:** Foundation — Durable Local Library Storage

**Objective:** Add a runtime-neutral library-storage application contract that lets the future Bun CLI adapter and Tauri desktop boundary share one explicit contract without importing Bun-only runtime code.

## Decision

SQLite is selected for the immediate durable local-store implementation, using Bun's built-in `bun:sqlite` in a later Bun-only adapter package. This packet does not implement that adapter or any persistence behavior.

`@takio/core` remains the owner of the canonical `LibraryItem` domain value and validation. The new `@takio/library-contract` package owns only runtime-neutral operation, result, configuration, and error shapes. It must be safe to consume from a future browser/Tauri frontend boundary.

## Scope

**In scope**

- Create `packages/library-contract` with package metadata, TypeScript configuration, public entrypoint, focused tests, and concise package-local documentation.
- Define and export a runtime-neutral asynchronous library-store application port using `LibraryItem` from `@takio/core`.
- Define JSON-safe request/result and stable error-code shapes for initialization/opening, list, get, create/add, and remove operations.
- Require missing records to be represented as `null`, not runtime-specific `undefined`.
- Define stable, driver-independent error codes for duplicate IDs, invalid stored data, unavailable storage, and incompatible schema.
- Make the minimum root workspace-script changes required to check, test, and build the new package.
- Ensure the package build reproducibly emits the declaration entrypoint advertised by its package metadata.

**Out of scope**

- Any `bun:sqlite`, `Bun.*`, filesystem, database connection, SQL schema, migration, transaction, or durable-write implementation.
- Creation of a SQLite file or resolution of a production data directory.
- A Bun adapter package, CLI command, CLI integration, or CLI smoke path.
- Tauri commands, Rust code, Rust dependency additions, desktop frontend changes, or desktop build changes.
- Changes to `@takio/core` library-domain behavior or `InMemoryLibraryRepository` semantics.
- External dependency additions, converter work, queues, sync, import, metadata, covers, search, or device behavior.

## Required behavior

1. `@takio/library-contract` exports an asynchronous application port whose payloads use the canonical `LibraryItem` domain type from `@takio/core`; it must not duplicate that domain model.
2. The public contract contains no runtime Bun import, SQLite-driver import, or Bun-global requirement.
3. Missing library items are expressed as `null` at the application-contract boundary.
4. Error results use documented stable codes rather than Bun, SQLite, filesystem, or driver exception messages.
5. The contract is suitable for both a future Bun implementation and a future Tauri command bridge, while containing no implementation of either runtime.
6. After deleting `packages/library-contract/dist`, its build regenerates both its runtime entrypoint and the declaration entrypoint referenced by package metadata.
7. Existing core, CLI, and desktop behavior remains unchanged.

## Acceptance criteria

- `@takio/library-contract` is a workspace package with a narrow public API and package-local tests.
- Its public API can be type-checked without Bun globals or Bun-only modules.
- Tests cover `null` absence semantics and the stable error-code contract.
- The package's public types reuse `LibraryItem` from `@takio/core` rather than re-declaring it.
- The package does not import `bun:sqlite`, use `Bun.*`, or add any SQLite, Rust, Tauri, or external dependency.
- The clean declaration gate succeeds:

```bash
rm -rf packages/library-contract/dist
bun run --filter '@takio/library-contract' build
test -f packages/library-contract/dist/index.js
test -f packages/library-contract/dist/index.d.ts
```

- The following shared checks pass after the clean package build:

```bash
bun run --filter '@takio/library-contract' check
bun run --filter '@takio/library-contract' test
bun run check
bun run test
bun run build
git diff --check
```

## Required evidence

- A focused diff limited to the allowed package, its tests/documentation, and strictly necessary root workspace-script changes.
- Exact output from every required verification command, including the clean declaration gate.
- An explicit statement that no Bun/SQLite/Tauri implementation was added.
- A final summary naming the exported contract, stable error codes, and deliberately deferred runtime decisions.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
feat(storage): define runtime-neutral library contract
```

The commit must contain only this packet's implementation, tests, documentation, and strictly necessary workspace-script changes. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The contract is additive: it creates no persistent data, runs no migration, and changes no existing library-domain behavior.
