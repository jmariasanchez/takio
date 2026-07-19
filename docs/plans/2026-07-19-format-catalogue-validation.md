# Takio Format Catalogue & Validation Plan

> Planning artifact produced read-only with `claude-fable-5` on 2026-07-19. No code was changed or committed while drafting this plan.

**Goal:** Make the eight-format catalogue in `@takio/core` the single semantic for "does this file match this format," close the gap where the library can admit items it can later never open, and add minimal container-signature checks at the import trust boundary — Calibre-like usefulness for validation, with no conversion, no new package, and no new dependency.

**Depends on:** nothing unbuilt. All work extends `packages/core/src/formats.ts` and existing consumers. Conversion (Horizon 2) remains untouched.

## Current state

Exact files and behavior, verified against source on 2026-07-19:

- `packages/core/src/formats.ts` — the entire catalogue (38 lines). `FORMAT_IDS` is exactly eight ids: `epub`, `pdf`, `mobi`, `azw3`, `docx`, `html`, `txt`, `cbz`. Each `FormatDefinition` has `id`, `label`, `extensions`, `kind` (`"ebook" | "document" | "comic"`); `html` is the only multi-extension entry (`.html`, `.htm`); there is no mime field. `detectFormat(fileName)` lowercases the name and matches `endsWith(extension)` — pure string work, no filesystem access.
- `packages/core/src/index.ts:9` re-exports `FORMAT_CATALOG`, `FORMAT_IDS`, `detectFormat`, `FormatDefinition`, `FormatId`.
- `packages/core/src/planner.ts:39` — `planConversion` calls `detectFormat(parsed.input)` on a path-shaped string and throws `PlanningError` when undefined. Deliberately no filesystem access.
- `packages/core/src/library.ts:41` — `libraryItemSchema` validates `format` with `z.enum(FORMAT_IDS)` only; no extension cross-check.
- `apps/cli/src/main.ts`:
  - `library add` (lines 302–342) casts `--format` raw (`options.format as FormatId`, line 328). No filesystem access, no extension cross-check; only the store's `libraryItemSchema` enum check applies downstream.
  - `library import` (lines 360–430) runs `detectFormat(options.sourcePath)` plus `stat` → must be a regular file, else exit 1 `invalid-arguments`; then `realpath` and an atomic copy into the owned `items/` directory.
  - `library open` (lines 452–514) requires a regular file (`missing-file`), then compares the stored `item.format`'s catalogue extensions against `extname(item.sourcePath).toLowerCase()` — mismatch exits 1 with `format-mismatch` — before launching the OS default app.
  - `formats` prints the catalogue; `plan` delegates to `planConversion`.
- `apps/cli/src/destinations.ts` — `send` is format-agnostic by design (realpath + regular-file + sha256 transfer verification); it never consults the catalogue.
- `apps/desktop/src/App.tsx:20-22` — the file picker derives its Tauri dialog extension filter from `FORMAT_CATALOG` (advisory OS-level filter only).
- `apps/desktop/src-tauri/src/library_engine.rs:136-152` — `library_import` checks `is_file` only, then invokes the bundled CLI engine with an argument array; all format validation is delegated to the CLI.
- Tests: no `packages/core/test/formats.test.ts` exists. Coverage is indirect: `apps/cli/test/main.test.ts` (import rejects `book.xyz`/missing/directory sources; open rejects `tampered.sh` under a declared `epub` with `format-mismatch`), `packages/core/test/planner.test.ts` (unknown extension → `PlanningError`), `packages/core/test/library.test.ts` (`format: "mp3"` rejected by the enum).

Validation surface summary:

| Consumer | fs stat | extension check | declared-format vs file | content check |
| --- | --- | --- | --- | --- |
| `planConversion` (core) | no — by design | `detectFormat` on string | n/a | no |
| CLI `library add` | no | **no** | **no** | no |
| CLI `library import` | regular file | `detectFormat` | n/a (format derived) | no |
| CLI `library open` | regular file | `extname` vs catalogue | **yes → `format-mismatch`** | no |
| CLI `send` | regular file | no (by design) | no | sha256 transfer verify only |
| Desktop picker / Tauri import | `is_file` (Rust) | dialog filter only | delegated to CLI | no |

## Explicit assumptions

1. Bun 1.3.13 workspace; `bun:test` everywhere; no new dependencies. `node:fs/promises` `open`/`read` are available in Bun for the header read in Phase 3 — verify at implementation start; if absent, read via `Bun.file(path).slice(0, 1024).arrayBuffer()` instead.
2. The CLI error-code contract (`invalid-arguments`, `format-mismatch`, kebab-case codes, one JSON line on stdout, nonzero exit) is public API for agents. This plan reuses existing codes and introduces none.
3. The eight format ids, the `FORMAT_CATALOG` entry shape, and all existing exports are frozen. New behavior is additive exports only; `FormatDefinition` gains no field (signatures live in a module-private map).
4. Container signatures are honest about their ceiling: they identify the container family, not the exact format. A DOCX renamed `.epub` passes the ZIP check; `mobi` and `azw3` share the PalmDB `BOOKMOBI` signature. This plan therefore claims **container validation for six formats**, not full content validation. Nothing beyond these byte checks is claimed.
5. Existing CLI import test fixtures are plain-text files with book extensions; Phase 3 must update them to carry real container headers (called out in that phase, not discovered mid-implementation).

## Conflicts and chosen resolutions

Do not average these; each gets one resolution:

1. **`library add` vs `library open` (the real defect).** `add` accepts `--format epub` for `notes.sh`; `open` then permanently rejects that item with `format-mismatch`. Resolution: enforce `open`'s rule at `add` time (Phase 2). `open`'s check is the newer, test-hardened pattern (`main.test.ts` "rejects a source extension outside its declared format"), and admission-time enforcement has the smaller blast radius. The alternative — loosening `open` — would launch mislabeled files in OS apps and is rejected.
2. **Two extension-matching semantics.** Core uses `endsWith(".ext")`; `open` uses `extname(...)` + `extensions.includes`. They differ only on a file literally named `.epub` (dotfile: `extname` yields `""` → mismatch; `endsWith` → match). Resolution: one semantic, `detectFormat`-based, provided by a core helper; the dotfile edge becomes a documented, tested behavior of the unified helper.
3. **Layering: pure core vs filesystem edges.** `detectFormat` being extension-only and the planner accepting a path-shaped string is deliberate architecture (core stays pure; `stat`/`realpath`/reads live in the CLI and Tauri edges), not drift. Resolution: keep it. Core gains only pure functions (strings and bytes in, verdicts out); all filesystem access stays in `apps/cli`.
4. **Desktop advisory filter vs CLI enforcement.** The picker filter is advisory; real enforcement happens in the CLI engine that Tauri `library_import` delegates to. Resolution: keep — the desktop inherits Phases 2–3 for free through the engine. No Rust or React changes.

## Phase 1 — Pure catalogue helpers and direct tests in `@takio/core`

Strictly first: later phases consume these exports.

**Files:** modify `packages/core/src/formats.ts` and `packages/core/src/index.ts`; create `packages/core/test/formats.test.ts`.

**Behavior (additive exports only):**

- `formatMatchesFileName(id: FormatId, fileName: string): boolean` — implemented as `detectFormat(fileName) === id`. This is the single declared-format-vs-name semantic that `add` and `open` will share.
- `matchesSignature(id: FormatId, header: Uint8Array): boolean | undefined` — pure byte check against a module-private signature map (no new `FormatDefinition` field, no registry):
  - `epub`, `docx`, `cbz`: bytes 0–3 equal `0x50 0x4B 0x03 0x04` (ZIP local-file header; a valid book archive is never an empty ZIP).
  - `pdf`: ASCII `%PDF-` occurs within the first 1024 bytes (the spec tolerates a junk prefix; an offset-0-only check would false-reject real PDFs).
  - `mobi`, `azw3`: bytes 60–67 equal ASCII `BOOKMOBI` (PalmDB type/creator); returns `false` for headers shorter than 68 bytes.
  - `html`, `txt`: returns `undefined` — no reliable signature exists; callers must treat `undefined` as "cannot check," never as failure.

**Tests that encode intent** (`packages/core/test/formats.test.ts` — the first direct tests the catalogue has):

- `detectFormat` is case-insensitive (`BOOK.EPUB`) and maps `.htm` to `html` — because detection is the single admission decision for both the planner and the CLI import boundary; a case regression silently rejects valid books.
- `formatMatchesFileName("epub", "tampered.sh")` is false, and every catalogue entry matches a sample name for each of its own extensions — because this invariant is what makes `add` unable to admit an item `open` refuses. Include the dotfile edge (`.epub` matches) as the documented unified semantic.
- `matchesSignature` accepts/rejects representative byte buffers per format above, and returns `undefined` for `txt`/`html` — because the `undefined`/`false` distinction is what keeps unsniffable formats importable; collapsing it to `false` would break every txt/html import.

## Phase 2 — CLI consumers converge on one semantic

**Depends on:** Phase 1. **Files:** modify `apps/cli/src/main.ts`; extend `apps/cli/test/main.test.ts`.

- `library open`: replace the inline `FORMAT_CATALOG.find` + `extname` block (lines 487–494) with `formatMatchesFileName(item.format, item.sourcePath)`; same `format-mismatch` code, same exit. Behavior-preserving except the documented dotfile edge.
- `library add`: after option parsing, if `FORMAT_IDS.includes(options.format)` but `!formatMatchesFileName(options.format, options.sourcePath)`, exit 1 with `format-mismatch` before opening the store. Unknown format ids still fall through to the store's existing schema error so that error code is unchanged. `add` stays filesystem-free (surgical: a name-vs-name check only).

**Tests that encode intent** (extend `apps/cli/test/main.test.ts`):

- `library add --format epub --source-path …/book.sh` exits 1 with `format-mismatch` and creates no row and no database file — because every item the library admits must be openable; today this exact input creates a permanently unopenable item.
- `library add` with an unknown `--format` still returns the store's existing error code — because the agent-facing error contract must not shift.
- The existing open tamper test passes unchanged — proving the refactor preserved `open`'s behavior.

## Phase 3 — Container-signature check at the import trust boundary

**Depends on:** Phases 1–2. **Files:** modify `apps/cli/src/main.ts` (`library import` action); extend `apps/cli/test/main.test.ts` (including updating existing fixtures).

- In `library import`, after the current stat/regular-file/`detectFormat` gate and `realpath` (lines 370–382) and before any `mkdir`/copy/store work: read the first `min(1024, size)` bytes of the source, call `matchesSignature(format, header)`, and exit 1 with `format-mismatch` when it returns `false`. `true` and `undefined` proceed. One guard clause; no copy, temp file, or database row is created on rejection.
- Roadmap grounding: "File imports … are untrusted input." Import is where a spoofed file enters the owned `items/` directory and is later handed to `open`'s OS launcher; this is the one place a content check pays for itself. Adding the same check to `open` (defense for pre-existing rows) is deferred — see non-goals.
- The desktop inherits this automatically via Tauri `library_import` → CLI engine. No desktop changes.
- **Fixture migration (explicit):** existing import tests write plain text into `.epub`-named files; update them to start with `PK\x03\x04` bytes so they represent real containers. This is a test-honesty fix, not churn: the old fixtures encoded exactly the extension-only assumption this phase removes.

**Tests that encode intent:**

- Importing `fake.pdf` containing non-PDF bytes exits 1 with `format-mismatch`, and afterward the items directory has no new file and the database has no row — because import is the trust boundary; without this, a spoofed extension plants an arbitrary payload that `library open` will later feed to the OS default application.
- Importing a `.txt` file with arbitrary bytes still succeeds — because unsniffable formats must remain importable (the `undefined` path).
- Importing an `.epub` whose bytes begin `PK\x03\x04` succeeds — the updated happy path.

## Non-goals

- Conversion, converter adapters, or the job queue (Horizon 2) — this plan never claims a conversion capability.
- Full content validation. Only the six container checks above are claimed; no EPUB `mimetype` entry check, no OPF parsing, no CBZ image-listing, no PDF xref validation, no `mobi`-vs-`azw3` disambiguation, nothing for `html`/`txt`.
- Any MIME database, MIME field, magic-byte dependency (e.g. `file-type`), plugin/registry mechanism, or new package.
- Changes to `packages/core/src/planner.ts` (stays pure), `apps/cli/src/destinations.ts` (`send` stays format-agnostic by design), `apps/desktop/src/App.tsx`, or any Rust code.
- New error codes, new CLI flags, or catalogue additions/removals — the eight ids are frozen.
- Content checks in `library open` for pre-existing rows (deferred until evidence of need).

## Exact runnable verification

```sh
bun install
bun run --filter '@takio/core' check
bun run --filter '@takio/core' test
bun run --filter '@takio/cli' check
bun run --filter '@takio/cli' test
bun run check
bun run test
bun run build
bun run takio formats --json
bun run takio plan --input ~/Books/example.epub --to pdf --json

# Trust-boundary smoke check (expect one JSON error line, exit 1):
printf 'not a pdf' > /tmp/takio-fake.pdf
bun run takio library import --db /tmp/takio-smoke.db --source-path /tmp/takio-fake.pdf
# expect: {"ok":false,"error":{"code":"format-mismatch"}}

git diff --check
```

## Success criteria

- All eight format ids, every existing export of `@takio/core`, and every existing CLI error code are unchanged; the new surface is at most three pure additive exports.
- Invariant holds: any item admitted by `library add` or `library import` after this change passes `library open`'s format gate (no admission path can create a `format-mismatch`-doomed item).
- A container-spoofed file (the `fake.pdf` smoke check) is rejected at import with `format-mismatch` before any file copy or database write.
- `txt`/`html` imports with arbitrary content still succeed.
- `bun run check`, `bun run test`, and `bun run build` pass at every phase boundary, and `packages/core/test/formats.test.ts` exists as the catalogue's first direct test file.

## Rollback and safe disable

- One commit per phase; revert in reverse order. Phase 1 is additive-only (reverting it alone is safe once 2–3 are reverted). Reverting Phase 2 restores the inline `open` check and permissive `add`. Phase 3's safe-disable is deleting one guard clause in `library import`, which restores exact extension-only behavior.
- No schema change, no migration, no persisted-data impact anywhere: all checks are admission-time reads. Existing library rows and files are never rewritten, so rollback never requires data repair.

## Micro-commit boundaries

1. `feat(core): centralize format validation` — Phase 1 only; core check/test green.
2. `fix(cli): align format checks across commands` — Phase 2 only; CLI check/test green.
3. `fix(cli): validate imported format signatures` — Phase 3 only; full workspace gates green.
