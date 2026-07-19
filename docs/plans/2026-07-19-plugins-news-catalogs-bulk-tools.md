# Takio Plan: Calibre-Adjacent Plugins, News, Catalogs, and Bulk Tools

> Planning artifact produced read-only with `claude-fable-5` on 2026-07-19, grounded against the current repository.

**Decision up front:** this topic bundles four separate capabilities — plugins, news, catalogs, and bulk tools. They are not one feature and are not averaged here. Exactly one has a prerequisite that exists in the repository today: a bulk operation over the tested single-item import primitive. This plan builds one bounded MVP, `takio library import-many`, and defers plugins, news, and catalogs behind explicit demand/prerequisite gates with their security boundaries recorded. No batch-conversion facade is proposed because conversion execution does not exist.

## Current implemented truth

- `@takio/core` (`packages/core/src/`): format catalogue and `detectFormat` (`formats.ts`); planner producing planned jobs only (`planner.ts`); validated `LibraryItem` with author/description/cover/tags/updatedAt and `normalizeTags` (`library.ts`); pure destination helpers `classifyDestinationKind`, `defaultDestinationSubdir`, `sanitizeDestinationFileName` (`destinations.ts`).
- `@takio/library-contract` (`packages/library-contract/src/index.ts`): runtime-neutral `LibraryStore` with `open/list/get/add/update/setCover/removeCover/search/remove`, stable error codes, and desktop wire-result aliases.
- `@takio/library-store-bun` (`packages/library-store-bun/src/index.ts`): schema-v2 SQLite store with a verified v1→v2 migration and backup, normalized tag tables, owned covers with containment checks, and escaped `LIKE` search.
- `@takio/cli` (`apps/cli/src/main.ts`, `destinations.ts`): `formats`, `devices`, `plan`; JSON-protocol `library add|list|import|get|open|update|search|cover set|cover remove|remove`; `destination list|eject`; `send` with streaming SHA-256 copy-and-verify to mounted macOS volumes. The durable local library import/list/get/update/search/cover/remove flow, the desktop Tauri bridge, and macOS mounted-destination transfer all exist and are tested.
- `@takio/desktop`: real library state — `src-tauri/src/lib.rs` registers seven `library_*` commands backed by a bundled Bun CLI engine (`library_engine.rs`, `scripts/build-library-engine.ts`); `src/lib/library.ts` is the typed invoke seam; `App.tsx` renders store-backed state.
- **Still not implemented:** conversion execution (the `plan` command explicitly reports "no converter adapter is configured yet"), a persistent job queue, device agents, viewer/editor/content server, plugins, news, catalogs, and any bulk command.
- CLI JSON protocol (hardened in `apps/cli/test/main.test.ts`): exactly one physical line on stdout, `{"ok":true,"value":…}` or `{"ok":false,"error":{"code":…}}` with kebab-case codes, nonzero exit on failure, no Commander prose, and `--db` optional with a `TAKIO_DATA_DIR`-overridable platform data directory.

## Explicit assumptions

1. Bulk import of explicit file paths is the most useful bulk operation available today: import is how every item enters the library, the single-item path (`library import` action in `apps/cli/src/main.ts`) is atomic and tested, and "add a folder of books" is the canonical Calibre-adjacent bulk need. Bulk send/update/remove are deferred, not blended in.
2. Shells and agents expand globs; the CLI accepts explicit file paths only. No directory recursion in the MVP.
3. Sequential per-item execution is correct for the MVP: the SQLite store is a single writer and the work is local disk I/O. Bounded concurrency is a documented upgrade path, not a requirement.
4. The batch envelope may carry per-item results inside the error object for this one command. This is a deliberate, tested extension of the protocol, not a new protocol.
5. No new dependencies. `commander`, `bun:sqlite`, `node:fs`, and existing helpers cover everything.

## Conflicts and stale documentation

- **README is stale.** Its current milestone and CLI table describe only formats/devices/plan and call the desktop a shell; the workspace tree omits `packages/library-contract` and `packages/library-store-bun`. Current source and the 2026-07-18 plans are authoritative. This plan does not rewrite the README (surgical scope); that needs its own cleanup.
- **`docs/plans/2026-07-18-desktop-library.md` current state is historical.** The mock desktop it describes has since been replaced by the real bridge. The plan's boundary rules remain valid.
- **Two output patterns coexist:** legacy human tables (`formats`, `devices`) versus the newer test-hardened single-line JSON protocol (`library`, `destination`, `send`). The new command follows the JSON protocol because it is newer and test-enforced. The legacy pattern is left untouched and flagged, matching the resolution in the device-detection plan.

## Dependency order

1. **Phase 1** — extract the single-import helper (behavior-preserving refactor). No prerequisites.
2. **Phase 2** — `takio library import-many` on top of Phase 1.
3. **Deferred and gated:** other bulk operations require demand plus their single-item prerequisite; plugins require local conversion execution plus two real adapters; news requires user demand plus a security spike; catalogs require a concrete requested export format; batch conversion requires conversion execution to exist.

## Phase 1 — Extract the single-import primitive

No behavior changes in this phase.

**Files:** create `apps/cli/src/library-import.ts`; modify `apps/cli/src/main.ts`.

**Required behavior:**

- Move the body of the `library import` action into one exported function, following the `destinations.ts` sibling-module pattern: validate the source is a regular file with a detectable format, resolve `realpath`, generate `item_<uuid>`, copy to a temporary name under `items/`, rename atomically, insert the row, and on any failure remove only the files this invocation created. Signature shape: `importLibraryFile(store, itemsDirectory, { sourcePath, title? })` returning `{ ok: true, item }` or `{ ok: false, code }` with the existing codes (`invalid-arguments`, `duplicate-id`, `storage-unavailable`).
- The `library import` command action becomes: open store, call helper, map a failure code through `command.error`, print the existing `{ok:true,value:{item}}` line. Output, codes, and exit statuses remain byte-identical.

**Exit criteria:** every existing test in `apps/cli/test/main.test.ts` passes unchanged. That suite already pins the import protocol, cleanup on failure, and help/error isolation, so it is the refactor guard. `bun run check` passes.

## Phase 2 — `takio library import-many`

This is the only new capability.

**Files:** modify `apps/cli/src/main.ts` to register through the existing `storageCommand` wrapper; modify `apps/cli/src/library-import.ts` to add the batch runner; modify `apps/cli/test/main.test.ts`.

**Command:**

```text
takio library import-many [--db <path>] --source-path <path> [--source-path <path> ...]
```

**Required behavior, in order:**

1. `--source-path` is repeatable using the same accumulate pattern as `library update --tag`. Zero paths return `{"ok":false,"error":{"code":"invalid-arguments"}}`, exit 1. There is no `--title`; batch titles always derive from filenames.
2. Open the store once through the existing `openLibraryStore`. An open failure is a whole-command failure with the store's error code before any item is touched.
3. Process paths sequentially in input order, each through the Phase 1 helper. The batch contains no duplicated import logic, so every single-item safety guarantee—atomic copy/rename, cleanup of invocation-created files only, and no shell strings—holds per item. A failed item does not stop the batch; later items still import. Duplicate input paths import independently with fresh IDs, matching two single-import invocations.
4. **Cancellation:** the action creates an `AbortController`, wires it to `process.once("SIGINT", …)`, and removes the listener when done. The runner checks `signal.aborted` before starting each item. Remaining items receive `{ ok: false, code: "cancelled" }`. Already committed items stay committed; cancellation is honest, not rollback.
5. **One JSON line, truthful partial failure.** Per-item results are `{"sourcePath":…,"ok":true,"item":…}` or `{"sourcePath":…,"ok":false,"code":…}`, in input order.
   - Every item succeeded → `{"ok":true,"value":{"results":[…]}}`, exit 0.
   - Any item failed or was cancelled → `{"ok":false,"error":{"code":"import-incomplete","results":[…]}}`, exit 1.
   A partially failed batch is never reported as success; per-item codes let an agent retry exactly the failures.
6. Close the store in `finally`, matching every other library command.

Sequential execution is a deliberate ceiling. Record it with a `ponytail:` comment naming bounded concurrency as the upgrade path only if import throughput measurably matters.

**Exit criteria:** all intent tests below pass; workspace check/test/build gates are green; the temporary-directory smoke behaves exactly as documented; no existing command output changes.

## Intent-focused tests

Extend `apps/cli/test/main.test.ts` with the existing `invoke`/`invokeProcess`/`parseOutput` harness and temporary data directories. Each test must fail if its named guarantee is removed:

1. **Three valid files produce one physical JSON line, input-ordered results, and items retrievable through `library get`.** This protects deterministic agent parsing.
2. **A missing or unsupported middle path does not stop later imports; the envelope is `ok:false`, `import-incomplete`, exit 1; the failed item is `invalid-arguments`.** This protects fail-loud partial results and the purpose of batching.
3. **A failed item leaves no file under `items/` and no `.tmp-*` residue.** Inject failure the same way as the existing single-import cleanup test. This catches any unsafe duplicate import implementation.
4. **A pre-aborted signal imports nothing and marks every result `cancelled`; abort after the first item preserves the first item and cancels the rest.** Exercise the exported runner directly for deterministic signal timing. This protects truthful interruption state.
5. **No `--source-path` returns `invalid-arguments`, exit 1, with no store side effects.** This prevents an empty glob from looking like a successful import.
6. **Existing `library import` process tests pass unchanged.** This protects backward compatibility across the helper extraction.
7. **`library import-many --help` follows the existing nested-help protocol.** This prevents Commander prose from leaking into the JSON stream.

## Exact runnable verification

```sh
bun install
bun run check
bun run --filter '@takio/core' test
bun run --filter '@takio/library-contract' test
bun run --filter '@takio/library-store-bun' test
bun run --filter '@takio/cli' test
bun run test
bun run build
git diff --check

# Safe temporary-directory CLI smoke; never touches the real data directory
DATA="$(mktemp -d)"; SRC="$(mktemp -d)"
printf 'one' > "$SRC/a.txt"; printf 'two' > "$SRC/b.txt"
TAKIO_DATA_DIR="$DATA" bun run takio library import-many \
  --source-path "$SRC/a.txt" --source-path "$SRC/b.txt"
TAKIO_DATA_DIR="$DATA" bun run takio library list
TAKIO_DATA_DIR="$DATA" bun run takio library import-many \
  --source-path "$SRC/a.txt" --source-path "$SRC/missing.txt"; echo "exit=$?"
rm -rf "$DATA" "$SRC"
```

Any skipped or failing check blocks completion and must be reported, not summarized away.

## Deferred capability 1 — Plugins

**Gate:** local conversion execution exists (architecture roadmap steps 1–3) and at least two real converter adapters have shipped behind the `ConverterAdapter` contract, proving the seam against concrete uses. Until two implementations exist, any plugin API is speculation under the roadmap rule that every generalization needs a second concrete use.

**Explicitly not now:** no plugin runtime, API surface, dynamic code loading, marketplace, dependency, or sandbox theater. Loading arbitrary code in-process is not a security boundary.

**Recorded trust boundary for later:** plugin code is untrusted and must never inherit the CLI's filesystem authority over `items/`, `covers/`, or the database. The realistic first seam is an out-of-process adapter speaking the hardened one-line JSON protocol over argv/stdout—the boundary already proven by `library_engine.rs`—not an in-process extension API.

## Deferred capability 2 — News and feed fetching

**Gate:** concrete user demand plus a deliberate security spike reviewed before any code. Takio currently makes no network requests; news would be its first network surface. No scheduler, fetcher, or recipe system now.

**Recorded trust boundaries for that future spike:**

- **SSRF:** feed and article URLs are untrusted. Refuse loopback, RFC-1918/private, link-local, and cloud metadata addresses; resolve and check at connection time.
- **Redirects and DNS rebinding:** revalidate every redirect hop and DNS resolution because a public hostname can resolve to an internal address later.
- **Credential leakage:** per-feed credentials, if ever supported, must never follow cross-origin redirects or appear in stored output, logs, or JSON.
- **Untrusted content:** fetched HTML, XML, and archives are hostile. Neutralize XML external entities, decompression bombs, and scripts; parse only quota-limited input.
- **Resource quotas:** impose hard byte, time, and item-count limits per fetch so a feed cannot fill disk or hang the process.
- **Output sanitization:** sanitize any library-owned artifact before writing and never render fetched content in the desktop webview outside a sandboxed, IPC-free frame.

## Deferred capability 3 — Catalogs

**Gate:** a concrete requested export format with a named consumer, such as CSV for a spreadsheet or OPDS for a reader. `takio library list` and `library search` already emit the complete machine-readable inventory. That JSON is the agent contract, not a generated catalog product. EPUB/CSV/OPDS generation is a new serialization surface and waits for a request that names its format. OPDS also depends on the content-server gates and is doubly deferred.

## Deferred bulk operations beyond the MVP

- **Bulk send:** the single-item `sendToDestination` primitive exists and is safe, so this is the natural second bulk tool. Defer it until requested, then reuse the per-item-results envelope proven by `import-many`.
- **Bulk metadata update and remove:** defer until requested. Remove deletes owned files, so a bulk form needs an explicit confirmation design rather than a loop bolted on.
- **Batch conversion:** blocked outright. There is no conversion execution to batch. A facade over `plan` would misrepresent planned jobs as performed work.

## Non-goals

No plugin runtime or API, news/feed code, catalog generator, network request, scheduler, daemon, generic workflow engine, persistent job queue, concurrency framework, directory recursion, glob expansion, progress streaming, resume journal, new dependency, schema change, desktop UI change, README rewrite, or claim of broad Calibre parity.

## Overall success criteria

1. `takio library import-many` imports explicit files through the unchanged single-item primitive with one deterministic JSON line of per-item results.
2. Partial failure and cancellation are truthfully reported with `import-incomplete`, per-item codes, and nonzero exit; intent tests fail if those guarantees are removed.
3. Every existing command output and existing test remains byte-identical.
4. `bun run check`, `bun run test`, and `bun run build` pass with zero skipped tests; the smoke transcript matches this document.
5. The three deferred capabilities have recorded gates and security boundaries, with no speculative scaffolding in the tree.

## Rollback and safe disable

Everything is additive: no schema change, migration, persisted config, background process, or dependency. Safe-disable means removing the `import-many` registration in `apps/cli/src/main.ts`. Full rollback means reverting Phase 2 and, independently if desired, the behavior-preserving Phase 1 refactor. Items imported by a partially failed or cancelled batch are ordinary committed library items, visible through `library list` and removable through `library remove`; rollback never deletes user data.

## Micro-commit boundaries

1. `refactor(cli): extract the single-file import action` — Phase 1 only; behavior and process-level output stay byte-identical.
2. `feat(cli): import explicit files in sequence` — Phase 2 only; partial failure, cancellation, and full workspace gates green.
