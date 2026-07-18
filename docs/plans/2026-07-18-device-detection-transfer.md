# Takio Device Detection & Transfer Plan

> Planning artifact produced read-only with `claude-fable-5` on 2026-07-18.

**Goal:** Let a user or agent detect a physically connected e-reader (mounted as a USB mass-storage volume) and copy a library item's file onto it — verified, collision-safe, with deterministic CLI JSON.

## Current state

- `@takio/core` (`packages/core/src/planner.ts`) defines `Device` as a **conversion execution target** (`supportedOutputs`, `online/offline`, `localDevice`). It is consumed by `planConversion` and the `takio devices` / `takio plan` commands.
- `docs/architecture.md` plans a future **device agent**: an authenticated remote worker (Horizon 4 in `docs/roadmaps/claude-fable-5-product-roadmap.md`).
- Neither is a Calibre-style *recipient device* (an e-reader you copy files onto). That concept does not exist in the repository.
- Conversion execution and a persistent queue do not exist. The CLI has `formats`, `devices` (table), `plan`, and a JSON-only `library` group backed by `BunSqliteLibraryStore` (`packages/library-store-bun/src/index.ts`).
- The `library` group has a hardened protocol (see `apps/cli/test/main.test.ts`): exactly one physical line of JSON on stdout, `{ok:true,value:…}` / `{ok:false,error:{code}}`, kebab-case error codes, nonzero exit on failure, no Commander prose.
- `packages/library-store-bun/src/initialization-test-seam.ts` establishes the repository's pattern for injecting failures in tests.

## Conflict resolution: three "device" concepts, three names

Do not average these models. Explicit boundaries:

| Concept | Name | Where | Status |
| --- | --- | --- | --- |
| Conversion execution target (`planConversion`) | `Device` (existing) | `@takio/core` planner | Keep unchanged. Flag for a later rename to `ExecutionTarget` when conversion lands — **not in this plan** (surgical scope). |
| Recipient e-reader mounted over USB (Calibre-style) | **`Destination`** | New: pure helpers in `@takio/core`, OS glue in `@takio/cli` | This plan |
| Authenticated remote worker | Device agent | Horizon 4, not built | Deferred entirely. Nothing in this plan creates protocol, daemon, or auth surface. |

CLI consequence: the existing `takio devices` command (planner table) stays untouched. New nouns are `takio destination …` and `takio send`, following the **library JSON protocol** (the newer, test-hardened pattern) rather than the older table-output pattern. That divergence is deliberate and flagged: `formats`/`devices` table output is the legacy pattern; new commands are JSON-only.

## Explicit assumptions

1. **macOS only for now** (repository development platform is Darwin). Detection means enumerating `/Volumes`. Linux (`/media/$USER`) and Windows are deferred.
2. **USB mass-storage only.** Devices that mount as MTP (including recent Kindle firmware on macOS) do not appear in `/Volumes` and are out of scope. This is stated honestly; there is no pretense of Calibre driver parity.
3. **Sending the original library file is useful before conversion exists.** Kobo and generic readers accept EPUB/PDF directly, so import → send is a complete flow today. For Kindle, value is partial until Horizon 2 conversion exists. The plan does not add format gating yet.
4. `node:fs` `statfs` is assumed available in Bun 1.3 for free-space reporting. Verify at implementation start; if absent, omit the optional `freeBytes` field rather than adding a dependency or parsing `df`.
5. `LibraryItem.sourcePath` may be relative (existing tests store relative paths); `send` resolves it against the CLI working directory.
6. No new dependencies. `commander`, `zod`, `bun:sqlite`, `node:fs`, `node:path`, and `node:crypto` cover the work.

## Dependency ordering and prerequisites

- Nothing here is blocked by conversion or the queue. `send` copies `LibraryItem.sourcePath`, a plain file that exists today. Sending *converted artifacts* is blocked and deferred until Horizon 2.
- The phase order below is a strict dependency chain: pure core helpers → read-only detection → transfer → eject/docs. Phase 2 (`destination list`) is the read-only slice that can land alone.
- Remote device agents stay in Horizon 4. This plan only keeps `Destination` (a passive mounted volume) separate from the agent protocol.

## Phase 1 — Pure domain helpers in `@takio/core`

**Files:** create `packages/core/src/destinations.ts`, `packages/core/test/destinations.test.ts`; modify `packages/core/src/index.ts` to re-export.

**Behavior:**

- `DESTINATION_KINDS = ["kindle", "kobo", "generic"] as const` and a `Destination` type: `{ id, name, path, kind, freeBytes? }` (`id` is the deterministic volume-directory basename).
- `classifyDestinationKind(rootEntries: readonly string[]): DestinationKind` is pure and takes directory-entry names: `documents` + `system` → `kindle`; `.kobo` → `kobo`; otherwise `generic`. Core performs no filesystem access.
- `defaultDestinationSubdir(kind)` returns `"documents"` for Kindle and `""` otherwise.
- `sanitizeDestinationFileName(name: string): string | null` permits a basename only, strips control characters and FAT-illegal characters (`<>:"/\\|?*`), and returns `null` for empty, `.`, or `..` results. This is the single choke point for filename trust and FAT32/exFAT compatibility.

**Tests that encode intent:** classification requires both Kindle markers so a USB stick with only `documents/` is not misclassified; sanitization turns a traversal-shaped name into a contained basename and rejects names that reduce to nothing.

## Phase 2 — `takio destination list`

This is a read-only slice that can land alone.

**Files:** create `apps/cli/src/destinations.ts`, `apps/cli/test/destinations.test.ts`; modify `apps/cli/src/main.ts`.

**Behavior:**

- `listDestinations(volumesRoot: string): Promise<Destination[]>` reads the volume-root entries. For each, resolve `realpath`; exclude the boot volume (realpath `/`), non-directories, and unreadable entries; classify via the core helper; attach `freeBytes` via `fs.statfs` when available. Sort by `id` for deterministic output.
- `takio destination list [--volumes-root <path>]` is JSON-only, using the library protocol: one physical stdout line, `{ok:true,value:{destinations:[…]}}`, exit 0. `--volumes-root` defaults to `/Volumes` and exists for tests and future platform support.
- Register `destination` as a `storageCommand` group in `main.ts`, reusing the existing help/error isolation.

**Tests that encode intent:** create a temporary volumes root containing mock Kindle (`documents/` + `system/`), Kobo (`.kobo/`), and generic volumes plus a symlink to `/`. The symlink must be excluded so the boot disk can never be offered as a copy target. Output must be one physical line in deterministic order. A missing or unreadable volumes root returns `{ok:false,error:{code:"destination-unavailable"}}`, exit 1.

## Phase 3 — `takio send`

**Files:** modify `apps/cli/src/destinations.ts` and `apps/cli/src/main.ts`; extend `apps/cli/test/destinations.test.ts`; create `apps/cli/src/destination-test-seam.ts`, mirroring the existing initialization test-seam pattern.

**Command:**

```text
takio send --db <path> --id <item-id> --dest <volume-path> [--subdir <dir>] [--overwrite] [--volumes-root <path>]
```

**Required behavior, in order:**

1. **Explicit destination authorization:** `--dest` is mandatory. Its realpath must equal the realpath of a currently detected destination from `listDestinations`; anything else returns `unknown-destination`. Never default to the first device.
2. Look up the item in `BunSqliteLibraryStore`, reusing existing store open/error handling. Missing item returns `unknown-item`; a missing or unreadable `sourcePath` returns `source-unavailable`.
3. **Path containment:** target directory is the volume plus `--subdir` or `defaultDestinationSubdir(kind)`. Reject absolute or escaping subdirectories using `path.relative`. Sanitize the source basename; if it becomes empty, use `<item-id>.<ext>`. After `mkdir -p`, resolve the directory realpath and re-check containment because device-side symlinks are untrusted.
4. **Collision handling:** if the target exists and `--overwrite` is absent, return `destination-file-exists` and leave the target untouched. Never silently overwrite.
5. **Copy and verify:** stream the source to `.takio-partial-<uuid>` in the target directory while hashing with SHA-256; `fsync` the temporary file; re-read it from disk and hash again; compare source and destination size and digest. On mismatch return `verification-failed`, remove the temporary file, and create no final file. On I/O error return `copy-failed` and best-effort remove the temporary file.
6. **Safe disconnect semantics:** after verification, rename the temporary file to the final name on the same volume and `fsync` the target directory before reporting success. Return `{ok:true,value:{itemId,destinationId,path,bytes,sha256}}`; do not expose timestamps or the random temporary name.
7. Add an `afterPartialWrite?.(partialPath)` test seam so tests can corrupt the copy between write and verification.

**Tests that encode intent:**

- Happy path: bytes and SHA-256 in JSON match an independently computed hash of the destination file.
- Collision without `--overwrite` returns `destination-file-exists` and preserves the original bytes.
- `--overwrite` replaces content and still verifies.
- A destination outside the volume root returns `unknown-destination`.
- `--subdir ../escape` returns `invalid-arguments`.
- The test seam truncates the partial copy and proves `verification-failed`, no final file, and no leftover partial.
- Every failure is one JSON line with nonzero exit.

## Phase 4 — `takio destination eject` and documentation

**Files:** modify `apps/cli/src/main.ts`, `apps/cli/src/destinations.ts`, `apps/cli/test/destinations.test.ts`, and `docs/architecture.md`.

- `takio destination eject --dest <volume-path> [--volumes-root <path>]` performs the same authorization check as `send`, then calls `Bun.spawn(["diskutil", "eject", realpath])` with an argument array, never a shell string. A nonzero exit returns `eject-failed`; non-Darwin returns `unsupported-platform`; success returns `{ok:true,value:{destinationId}}`.
- Tests cover authorization and the JSON protocol. The real `diskutil` call is not exercised in CI and must be explicitly listed as a manual check.
- Update `docs/architecture.md` with a destination-transfer row and one sentence distinguishing `Destination` from the planned device agent. Do not touch unrelated sections.

## Trust boundaries and security

- Volume names and directory entries, library metadata (`title`, `sourcePath`), `--subdir`, and `--dest` are untrusted. Each passes through realpath/containment checks or `sanitizeDestinationFileName` before a write.
- Treat the destination volume as hostile: resolve and re-check symlinks before writing.
- Never interpolate a shell command. The only child process is `diskutil` with an argument array.
- Verify digest and size by re-reading the destination disk, satisfying the architecture rule to verify artifacts before and after transfer.
- Add no network listener, daemon, credential, or protocol surface.

## Exact runnable verification

```sh
bun install
bun run check
bun run --filter '@takio/core' test
bun run --filter '@takio/cli' test
bun run test

# End-to-end with a fake volume (no hardware needed)
mkdir -p /tmp/vols/FAKEKOBO/.kobo
bun run takio destination list --volumes-root /tmp/vols
bun run takio library add --db /tmp/lib.sqlite --id b1 --title T \
  --source-path README.md --format txt --added-at 2026-07-18T00:00:00.000Z
bun run takio send --db /tmp/lib.sqlite --id b1 --dest /tmp/vols/FAKEKOBO --volumes-root /tmp/vols
shasum -a 256 /tmp/vols/FAKEKOBO/README.md

# Manual macOS hardware check
bun run takio destination list
bun run takio send --db <db> --id <id> --dest /Volumes/<NAME>
bun run takio destination eject --dest /Volumes/<NAME>
```

## Non-goals and deferred work

- MTP devices, wireless transfer, and Send-to-Kindle email.
- Remote authenticated device agents, pairing, and revocation (Horizon 4).
- Sending converted artifacts until conversion and the queue exist.
- Format-compatibility gating, on-device collections/metadata, Linux/Windows detection, auto-eject, and watchers/daemons.
- Renaming planner `Device` to `ExecutionTarget` until the conversion milestone.

## Success and exit criteria

1. `takio destination list` classifies mock Kindle/Kobo/generic volumes and excludes the boot volume with deterministic output.
2. `takio send` places a byte-identical, digest-verified file on a fake volume and at least one real mass-storage e-reader, with the manual result recorded.
3. Collision, containment, unknown-destination, and verification-failure paths return the documented single-line JSON code with exit 1.
4. `bun run check` and `bun run test` pass with zero skipped tests. The real `diskutil eject` check remains explicitly manual.
5. Existing `devices`, `plan`, and `library` behavior remains byte-identical and green.

## Rollback and safe disable

Everything is additive: no schema change, migration, persisted config, dependency, or background process. Revert the commits or remove the `destination`/`send` command registrations. Library data is never written by these commands. A crash can leave only one `.takio-partial-*` file on the destination volume; it is safe to delete and is never reported as completed.

## Implementation-start checks

No hard blocker exists. Before implementation, verify `fs.statfs` in the pinned Bun (otherwise omit `freeBytes`) and obtain one real mass-storage e-reader for the manual hardware criterion. CI covers the rest through `--volumes-root`.
