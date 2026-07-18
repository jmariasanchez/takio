# Takio Real Desktop Library Plan

> Drafted with Claude Code using `claude-fable-5` on 2026-07-18, then grounded against the current repository.

**Goal:** Replace the desktop mock library with a truthful import, list, and remove flow over the same durable library used by the CLI.

**Depends on:** the production data location, owned-file import, and CLI `get`/`remove` work in the durable-library plan.

## Current state

- `apps/desktop/src/App.tsx` opens the native file picker but renders three hard-coded books and placeholder actions.
- The Tauri Rust library initializes only the dialog plugin; it has no library commands.
- The webview can consume runtime-neutral `@takio/core` and `@takio/library-contract` types, but it cannot import the Bun-only SQLite adapter.
- The CLI already provides the machine-readable seam around the Bun store. The durable-library plan makes that seam production-ready.

## Non-goals

Metadata/covers/tags/search, conversion, queues, devices, drag-and-drop, a visual redesign, direct SQLite access from the webview, duplicated Rust storage logic, an ORM, or a new dependency.

## Phase 1 — Freeze the desktop wire results

**Depends on:** the durable CLI commands.

**Likely files:** `packages/library-contract/src/index.ts`, `packages/library-contract/test/contract.test.ts`, `apps/cli/src/main.ts`, `apps/cli/test/main.test.ts`.

- Reuse `LibraryItem` and `LibraryStoreResult` rather than introducing a second book model.
- Export only any request/result aliases required to serialize `list`, `import`, and `remove` across Tauri. Error codes remain the stable library codes already emitted by the CLI.
- Pin the CLI protocol: one JSON value on stdout for success or domain failure, a nonzero exit for failure, and no diagnostic prose mixed into the record.

**Success criteria:** the contract remains free of Bun, Node, DOM, Tauri, and Rust imports; CLI process tests parse every desktop-used command; malformed arguments and storage errors cannot be mistaken for successful empty lists.

## Phase 2 — Add the smallest Tauri command boundary

**Depends on:** Phase 1.

**Likely files:** `apps/desktop/src-tauri/src/lib.rs`, optionally one focused Rust module, `apps/desktop/src-tauri/tauri.conf.json`, and the existing package/build scripts required to produce and bundle the CLI executable.

- Bundle the Bun-compiled CLI as the single library engine rather than reimplementing the schema and validation in Rust.
- Expose exactly three commands: `library_list`, `library_import`, and `library_remove`. Rust launches the bundled executable with an argument vector, never a shell string, and uses the Tauri app-data directory as the server-owned library location.
- Validate that an import source exists and is a regular file before launch; validate non-empty IDs; never accept a database path from the webview.
- Parse one CLI JSON record and map nonzero exits, empty/malformed output, and launch failures to explicit serializable errors. Do not claim a mutation succeeded until the child process exits successfully.

**Success criteria:** Rust tests cover argument validation, nonzero child exit, malformed protocol output, and success parsing; `cargo check` passes; CLI and Tauri path fixtures prove both surfaces resolve the same database; the release bundle contains the executable it invokes.

## Phase 3 — Replace mocks with real state

**Depends on:** Phase 2.

**Likely files:** `apps/desktop/src/App.tsx`, one typed invoke helper under `apps/desktop/src/lib/`, `apps/desktop/src/styles.css`, `apps/desktop/package.json`, and focused frontend tests.

- Delete `recentBooks`. Load `library_list` on mount and render explicit loading, empty, populated, and error states.
- Reuse the existing native file picker for `library_import`. Refresh from storage after success; do not optimistically invent an item.
- Replace the inert row menu with a remove action that names the book and requires confirmation. Remove a row only after the command succeeds; preserve it and show the error otherwise.
- Remove or disable controls whose behavior remains unimplemented. Keep conversion planning visually separate from library import.

**Success criteria:** no sample books or false online/controller state remains; relaunching shows the imported item; canceling removal performs no write; import and remove results are announced through accessible status/alert regions; every action is keyboard reachable and pending actions cannot be submitted twice.

## Boundary and data-safety checks

- Browser: typed request/result wrappers only; no filesystem/database location and no Bun-only import.
- Rust: fixed command allowlist, argument arrays, server-owned data path, bounded captured output, and explicit protocol failures.
- Bun CLI/store: all validation, file ownership, SQLite transactions, and deletion containment checks remain here.
- Destructive action: confirmation identifies the exact title; external files created through low-level `library add` are never deleted.

## Verification

```bash
bun run --filter '@takio/library-contract' check
bun run --filter '@takio/library-contract' test
bun run --filter '@takio/cli' check
bun run --filter '@takio/cli' test
bun run --filter '@takio/desktop' check
bun run --filter '@takio/desktop' test
bun run --filter '@takio/desktop' build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run check
bun run test
bun run build
git diff --check
```

Manual release-boundary check: launch the packaged app against an isolated data directory, import a document, quit and relaunch, verify it remains, cancel one removal, then confirm removal and verify the owned copy is gone. Run the CLI against that same location and confirm it lists the same state.

## Rollback

Revert the frontend and Tauri bridge without deleting the production data directory. The durable CLI remains usable and the schema does not change in this plan. If sidecar packaging fails, stop before landing Phase 3; do not replace it with a second Rust library store merely to unblock the UI.
