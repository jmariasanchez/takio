# Packet 001 — Shared Library Domain

**Horizon:** Foundation

**Objective:** Add a small, storage-independent library domain to `@takio/core` so future CLI and desktop library features share one contract.

## Scope

**In scope**

- `packages/core` only: exported library item types, validation, and an in-memory repository implementation.
- Tests that explain the library contract.
- Package-local documentation/comments only when needed to explain a public contract.

**Out of scope**

- Filesystem or SQLite persistence.
- CLI commands or desktop UI changes.
- Converter adapters, queues, remote devices, metadata fetching, cover images, or dependency additions.
- Changes to the existing conversion-planning contract.

## Required behavior

1. A library item has a stable non-empty identifier, title, source path, supported Takio format, and added-at timestamp.
2. The in-memory repository can add, list, retrieve by ID, and remove a library item.
3. Adding a duplicate ID must fail loudly.
4. Retrieving or removing an unknown ID must return an explicit absence result rather than throw.
5. `list()` must not expose mutable internal storage.
6. Existing format and conversion-planning behavior remains unchanged.

## Acceptance criteria

- The library domain is exported through `@takio/core`.
- Tests cover success and failure behavior for every repository operation, including duplicate IDs and unknown IDs.
- `bun run --filter '@takio/core' check` passes.
- `bun run --filter '@takio/core' test` passes.
- The complete workspace remains green under `bun run check` and `bun run test`.

## Required evidence

- A focused diff touching only the allowed scope.
- Exact output from all required verification commands.
- A final summary naming the public contract and any deliberately deferred decisions.
- An explicit disclosure of any check not run.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
feat(core): add shared library domain
```

The commit must contain only this packet’s implementation and tests. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The domain is additive and has no persistent-data migration.
