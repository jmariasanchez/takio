# Takio Metadata, Covers, Tags, and Search Plan

> Drafted with Claude Code using `claude-fable-5` on 2026-07-18, then grounded against the current repository.

**Goal:** Add small, local user-edited metadata, optional covers, normalized tags, and deterministic search after the real durable desktop library works.

**Depends on:** the durable-library and real-desktop-library plans.

## Current state

`LibraryItem` and SQLite schema v1 contain only `id`, `title`, `sourcePath`, `format`, and `addedAt`. The store revalidates persisted rows. The shared contract exposes only CRUD, the CLI exposes add/list, and the desktop currently uses mock records.

## Non-goals

ISBN or network lookup, automatic metadata extraction, authors as entities, series taxonomies, custom columns, advanced query syntax, OCR, image transformation/thumbnails, FTS, external search services, viewer/editor/server features, plugins, or cloud sync.

## Phase 1 — Extend the domain once

**Depends on:** a reviewed product field set.

**Likely files:** `packages/core/src/library.ts`, `packages/core/test/library.test.ts`.

- Add only `author?: string`, `description?: string`, `coverPath?: string`, `tags: readonly string[]`, and `updatedAt?: string` to `LibraryItem`. Keep title as the existing required display name; do not introduce separate person/series entities.
- Normalize tags with one pure function: trim, collapse internal whitespace, compare case-insensitively, reject empty values, and preserve one canonical display value.
- Keep metadata optional so every v1 item has a lossless default representation.

**Success criteria:** v1-shaped inputs still parse with empty/default optional metadata; validation rejects blank optional strings and duplicate normalized tags; tests explain that source identity fields cannot be changed by metadata edits.

## Phase 2 — Land the first forward migration

**Depends on:** Phase 1 and the migration/recovery gate in the durable-library plan.

**Likely files:** `packages/library-store-bun/src/index.ts`, focused migration fixtures/tests under `packages/library-store-bun/test/`.

- Migrate schema v1 to v2 by adding nullable scalar metadata columns, a nullable relative `cover_path`, and normalized `tags` plus `library_item_tags` tables with foreign keys and uniqueness constraints.
- Run the migration under the existing initialization lock and one SQLite transaction; set `PRAGMA user_version = 2` last.
- Create and verify the required pre-migration backup. Never rewrite `source_path`, original title, format, ID, or timestamp.
- Read tags in a deterministic order and reconstruct one validated `LibraryItem` per row.

**Success criteria:** a frozen v1 fixture upgrades and retains every original value; opening v2 again is a no-op; an injected migration failure leaves v1 readable; a future version is rejected without mutation; malformed metadata or tag rows return `invalid-stored-data` rather than leaking partial objects.

## Phase 3 — Add the minimum shared operations

**Depends on:** Phase 2.

**Likely files:** `packages/library-contract/src/index.ts`, `packages/library-contract/test/contract.test.ts`, `packages/library-store-bun/src/index.ts`, `packages/library-store-bun/test/library-store.test.ts`.

- Add one `update` operation for editable scalar metadata and complete tag replacement. Immutable fields (`id`, `sourcePath`, `format`, `addedAt`) are absent from its patch type.
- Add `setCover`/`removeCover` operations because cover file copying and containment are not ordinary scalar updates.
- Add `search({ query })`; return the same `LibraryItem` values as `list`.
- Implement case-insensitive escaped `LIKE` matching across title, author, description, and tag name. Order results by normalized title, then stable ID. An empty query is equivalent to `list`.

**Success criteria:** update is transactional across scalar fields and tag links; `%`, `_`, and the escape character are literal when supplied by the user; tag joins never duplicate items; search ordering is stable; setting a cover copies into Takio's `covers/` directory before recording its relative path and never modifies the selected image.

## Phase 4 — Expose agent-safe CLI primitives

**Depends on:** Phase 3.

**Likely files:** `apps/cli/src/main.ts`, `apps/cli/test/main.test.ts`.

- Add narrow `library update`, `library cover set|remove`, and `library search` commands. Tags are passed as repeatable values to `update`; do not create a separate tag command tree unless usage proves it clearer.
- Preserve one-line JSON results, stable errors, and nonzero failure exits. Search returns the same item envelope as list.

**Success criteria:** process-level tests round-trip edit, tag replacement, cover set/remove, and escaped search through separate invocations; cover failures leave prior cover state intact; nested help/error behavior remains compatible.

## Phase 5 — Add the desktop experience

**Depends on:** Phase 4 and the existing Tauri command pattern.

**Likely files:** `apps/desktop/src/App.tsx`, the existing typed library invoke helper, `apps/desktop/src/styles.css`, and focused desktop tests.

- Add a compact edit surface for title, author, description, and tags; use the native file picker for cover selection.
- Add one search field above the real library list. Query the store after a short UI debounce only if measurements show per-keystroke calls are disruptive; otherwise keep direct calls.
- Show the original item until an update succeeds. Covers have useful alt text derived from the title; missing covers use the existing text fallback.

**Success criteria:** a user can edit, tag, set/remove a cover, and search a real imported item without touching the filesystem; keyboard/focus behavior and validation errors are accessible; relaunch preserves every change; clearing search restores deterministic library order.

## Search ceiling

Start with indexed scalar columns, tag joins, and escaped `LIKE`. Record query-plan and timing evidence against a generated 5,000-item database. Add FTS only when representative searches repeatedly miss an agreed interaction budget and the query plan identifies text scanning as the cause; do not add FTS preemptively.

## Migration and data safety

- Source documents and user-selected cover originals are immutable inputs.
- Store cover paths relative to the controlled cover root; reject traversal and delete only canonical paths inside that root.
- Replacing a cover writes a new temporary file, atomically installs it, updates the row transactionally, then removes the old owned file. On failure, keep the old row/file pair.
- Removing an item cascades tag links and removes only its owned cover/source copies after the database mutation reports success; failures are surfaced for recovery.
- The verified v1 backup is retained until v2 integrity checking and full domain revalidation pass.

## Verification

```bash
bun run --filter '@takio/core' check
bun run --filter '@takio/core' test
bun run --filter '@takio/library-contract' check
bun run --filter '@takio/library-contract' test
bun run --filter '@takio/library-store-bun' check
bun run --filter '@takio/library-store-bun' test
bun run --filter '@takio/cli' test
bun run --filter '@takio/desktop' test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run check
bun run test
bun run build
git diff --check
```

The store test must build a v1 database from frozen SQL, insert multiple rows, migrate to v2, compare every v1 field, exercise metadata/tag/cover/search operations across close/reopen, run `PRAGMA integrity_check`, and prove source and cover originals are unchanged.

## Rollback

Revert CLI and desktop phases without changing stored data. Do not run a down-migration for v2. To roll back the schema implementation, close Takio, preserve the v2 database and owned covers, and restore the verified v1 pre-migration backup; report any post-migration metadata that cannot exist in v1 before restoration.
