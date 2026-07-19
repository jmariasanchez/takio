# Takio Daily-Driver Milestone Plan

> Planning-only handoff grounded in commit `b15f63ef97aa7801b3163005950bd07979bca1c8` on 2026-07-19. Implement this plan with Codex GPT-5.6 Sol at extra-high reasoning. Do not substitute Fable or Claude.

## Outcome

Make the existing macOS desktop library usable for the smallest complete daily workflow: import one or more supported files with the picker or drag-and-drop, open a library item in its default application, explicitly choose a mounted reader, send the original file with the existing verified transfer path, and safely eject the reader. The app must also expose normal macOS menus and shortcuts for the actions that exist in the window.

This milestone is complete only after all automated gates pass and both a real USB-mass-storage Kobo and a real USB-mass-storage Kindle pass the manual device gates below. Missing hardware is an unresolved acceptance gate, not permission to claim completion.

## Measurable success

1. A file imported by picker or drop appears once in the durable library and is still present after relaunch.
2. Dropping multiple paths imports each path through the existing single-file import command, refreshes once, and truthfully reports successes and every failure; partial success is never presented as total success.
3. **Open** launches the selected item's stored source through the existing `library open` CLI command. Missing files, extension/format mismatches, and launch failures remain visible errors.
4. Mounted destinations can be refreshed, inspected, and explicitly selected. Takio never silently selects the first mounted volume.
5. **Send** is disabled until both an item and destination are explicit. It copies the original stored file through the existing atomic, SHA-256-verified `send` command and reports the returned path, byte count, and digest. It does not overwrite an existing destination file.
6. **Eject** is unavailable while a send is in progress, invokes the existing authorized `diskutil eject` path, and refreshes the destination list after success.
7. Visible controls and native menus expose Import, Open Selected, Find, Send Selected, and Eject Selected. Import is `Shift-Command-I`, Open is `Command-O`, Find is `Command-F`, and Eject is `Command-E`; Send has no accelerator. Standard App, Edit, and Window menu behavior remains native.
8. The Kobo and Kindle procedures below each prove detection, transfer integrity, safe eject, rediscovery after reconnect, and successful opening on the physical reader.

## Verified ground truth at the planning commit

- The repository baseline was clean and `main` matched `origin/main` before this document was added.
- Bun `1.3.13`, Rust `1.97.1`, and Cargo `1.97.1` are installed. `bun run check`, `bun run test`, and `bun run build` pass. The test run reports 114 passing tests, zero failures, and no skips.
- `cargo check` and `cargo test` pass when Cargo uses `/usr/bin/cc` and Xcode's macOS SDK. The interactive shell currently resolves `cc` to the Nix profile, which omits the SDK search path and fails on `-liconv`; use the exact native commands in **Automated gates** until the developer shell is corrected.
- `apps/desktop/src/App.tsx` already provides durable list/import, metadata editing, search, cover management, and remove flows. It has no item-selection model, Open action, destination UI, Send/Eject actions, drag-and-drop import, or application menu wiring.
- `apps/desktop/src/lib/library.ts` invokes fixed Tauri commands. `apps/desktop/src-tauri/src/library_engine.rs` validates inputs, executes the bundled `takio-library-engine` sidecar with argument arrays, caps stdout/stderr at 8 MiB, and requires JSON/exit-code agreement. `apps/desktop/scripts/build-library-engine.ts` compiles `apps/cli/src/main.ts` as that sidecar.
- The CLI already implements `library open --id --json`. It verifies the stored source is a regular file, checks its extension against the stored format, and launches macOS `open` without a shell. Tests cover the exact process arguments and all failure classes.
- The CLI already implements `destination list`, `send`, and `destination eject`. `packages/core/src/destinations.ts` classifies Kindle, Kobo, and generic mounted volumes. `apps/cli/src/destinations.ts` authorizes exact detected real paths, confines target paths, rejects symlink escape and collisions, writes a temporary file, verifies size and SHA-256, renames atomically, fsyncs, and ejects through an argument-vector `diskutil` call. Fourteen destination tests cover mock Kindle/Kobo/generic volumes and transfer/eject failure paths.
- The installed Tauri v2 API already exposes drag/drop events and native menu primitives. No package or Cargo dependency is required for this milestone.
- README, architecture, and roadmap text still describe some of these capabilities as planned or unavailable. Executable code and its passing tests are the source of truth for this milestone; documentation cleanup is separate.

The current end-to-end boundary is:

```text
React UI -> typed invoke wrapper -> Rust Tauri command
         -> bundled Bun CLI sidecar -> durable library or mounted destination
         <- one JSON result record <- validated exit/output protocol
```

Preserve that boundary. Do not copy library, destination-discovery, transfer, or eject logic into React or Rust.

## Decisions and conflicts

- **Roadmap ordering:** the roadmap places unified daily use after local conversion. Original-file Open and Send already work independently, and the device plan explicitly permits useful original-file transfer. Therefore conversion is not a prerequisite here.
- **Database option mismatch:** every desktop-backed library CLI command defaults its database when `--db` is absent, but `send` uniquely requires `--db`. Make `send --db` optional while preserving the explicit override. This is the smallest way for the desktop sidecar to share the normal durable library without reimplementing database-path discovery in Rust.
- **Destination terminology:** planner “devices” and mounted transfer destinations are different concepts. Keep internal/API naming as `Destination`; use “reader” in user-facing copy. Do not connect the planner registry to USB transfer.
- **Kindle support:** direct EPUB delivery to an arbitrary Kindle is not promised. Validate a known-compatible AZW3 or MOBI file on a Kindle that appears under `/Volumes`. An MTP-only Kindle cannot satisfy this milestone and must be recorded as unsupported, not treated as a failed USB implementation.
- **Selection and safety:** selecting a library item may be restored in memory during the session, but selecting a reader must always be explicit after discovery/reconnect. Do not auto-send, auto-eject, or expose overwrite in this slice.
- **Menus:** use one native Tauri menu registration and emit fixed action events to React. Do not add duplicate document-level keyboard handlers. Visible buttons remain the primary discoverable controls.

## Prerequisites and assumptions

- macOS is the only acceptance platform for this slice; `library open`, `/Volumes`, native menu accelerators, and `diskutil eject` are platform-specific current behavior.
- Xcode's macOS SDK and Apple linker are available. The commands below deliberately bypass the Nix `cc` currently first on `PATH`.
- A default macOS application is registered for the files used by the Open checks.
- Test files are non-DRM and already compatible with the target reader. The imported library-owned source remains available.
- One Kobo and one Kindle that mount as ordinary writable volumes can be connected for acceptance. Record model, firmware, mount path, file format, byte count, SHA-256, and outcome.
- Destination discovery remains explicit startup/Refresh behavior. A watcher, daemon, or polling loop is not needed.

## Non-goals

- Format conversion, conversion capability detection, persistent jobs, queues, retries, or job history.
- A viewer, editor, reading server, web server, sync service, content server, or remote API.
- Plugins, agents, news feeds, catalogs, stores, bulk metadata tools, or Calibre-adjacent deferred tools.
- MTP, wireless Send-to-Kindle, network readers, automatic device watching, or automatic eject.
- Recursive directory import, a new bulk-import CLI command, or a second import pipeline.
- Destination compatibility matrices or format gating. The physical-reader tests use known-compatible originals; broader compatibility belongs with conversion.
- Overwrite UI or destructive collision recovery. Existing collisions remain explicit errors.
- Refactoring the existing monolithic desktop screen, restyling unrelated controls, or updating stale general documentation.

## Waterfall implementation

Complete and verify each phase before starting the next. If a phase's gate fails, stop and repair that phase rather than layering later UI over it.

### Phase 0 — Reconfirm the baseline

Likely files changed: none.

1. Confirm HEAD is the planning commit's descendant and inspect `git status --short --branch`; preserve unrelated user changes.
2. Run all automated gates before editing. If an existing failure differs from the baseline above, record it and stop rather than normalizing it into this milestone.
3. Confirm both physical readers are available before promising the final acceptance date. Implementation may proceed without them, but completion may not.

Gate: the existing Bun and native test suites pass with the documented Apple linker environment.

### Phase 1 — Make Send use the normal default library

Likely files:

- `apps/cli/src/main.ts`
- `apps/cli/test/destinations.test.ts`

1. Change only `send`'s `--db <path>` option from required to optional, update the action's option type to `db?: string`, and let the existing `openLibraryStore` resolve absence exactly as it does for library commands. Continue passing an explicit path unchanged when supplied.
2. Add a process-level test with `TAKIO_DATA_DIR` proving `send --id ... --dest ...` finds the default durable library without `--db` and returns the current verified JSON result.
3. Retain the existing explicit-database, collision, authorization, traversal, symlink, digest, corruption, and late-collision tests unchanged.

Gate: CLI check/tests pass, and both default and explicit database paths are proven.

Micro-commit: `fix(cli): use default library for send`

### Phase 2 — Expose existing CLI capabilities through Tauri

Likely files:

- `apps/desktop/src-tauri/src/library_engine.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src/lib/library.ts`
- `apps/desktop/src/lib/library.test.ts`
- `apps/desktop/src/lib/destinations.ts` (new)
- `apps/desktop/src/lib/destinations.test.ts` (new)

1. Add fixed Tauri commands for `library_open`, `destination_list`, `destination_send`, and `destination_eject` to the existing sidecar runner; do not add shell strings or another subprocess abstraction.
2. Construct only these argument arrays:
   - `library open --id <id> --json`
   - `destination list`
   - `send --id <id> --dest <mounted path>`
   - `destination eject --dest <mounted path>`
3. Validate non-empty IDs and destination paths at the bridge, then rely on the CLI's source validation, exact mounted-path authorization, collision handling, transfer verification, and eject implementation. Do not pass `--overwrite` or a UI-controlled `--volumes-root`.
4. Add typed desktop wrappers and result types. Reuse `Destination` from `@takio/core`; locally type the Send result (`itemId`, `destinationId`, `path`, `bytes`, `sha256`) and bridge failures. Keep fixed command names and camel-case invoke arguments consistent with the existing library wrapper.
5. Extend Rust argument/protocol tests and Bun wrapper tests so a command-name or argument-shape regression fails before a Tauri runtime is needed.

Gate: desktop Bun tests, Rust tests, and Cargo check pass; no new dependency or permission file is introduced.

Micro-commit: `feat(desktop): bridge open and destinations`

### Phase 3 — Add the visible daily-driver controls

Likely files:

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/styles.css`

1. Add an explicit selected-library-item ID and selected-destination ID. Clicking/focusing a library card may select it, and each card keeps visible **Open** and **Send** controls. Make selected state perceivable and accessible without changing metadata form behavior.
2. Add a compact reader bar with Refresh, a native `<select>` whose first option is “Choose a reader…”, free-space/kind labeling, and Eject. Load destinations at startup and on explicit Refresh; clear a selection when its destination disappears.
3. Route Open, Send, and Eject through the new wrappers. Use one operation-at-a-time pending state for device mutations, disable conflicting actions, and preserve exact backend failure distinctions in concise user-facing status.
4. On Send success, show the returned destination path, bytes, and SHA-256. On Eject success, refresh destinations and clear the ejected selection. On collision, tell the user the destination file already exists; do not silently rename or overwrite it.
5. Keep all library/destination data access outside JSX and avoid a component-system refactor. Extract a component only if the added markup cannot remain legible in the current file.

Gate: desktop check/test/build passes; manual smoke proves no action can send without an explicit reader and Eject cannot run during Send.

Micro-commit: `feat(desktop): add open send and eject controls`

### Phase 4 — Add drag import and native macOS commands

Likely files:

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/styles.css`
- `apps/desktop/src-tauri/src/menu.rs` (new)
- `apps/desktop/src-tauri/src/lib.rs`

1. Register Tauri's current-window drag/drop listener once and clean up the returned unlisten function on unmount. Show a drop affordance on enter/over and clear it on drop/leave.
2. Send picker paths and dropped paths through one App-level import routine. Process multiple paths sequentially through `library_import`, refresh the library once at the end, and report counts plus each rejected path/error. Do not traverse directories or add parallel imports.
3. Build one native menu in Rust:
   - App: About, Services, Hide/Hide Others/Show All, Quit.
   - File: Import (`Shift-Command-I`), Open Selected (`Command-O`), Send Selected (no accelerator), Eject Selected (`Command-E`), Close Window.
   - Edit: native Undo/Redo, Cut/Copy/Paste, Select All.
   - View or Edit: Find (`Command-F`).
   - Window: native Minimize and Zoom/Maximize behavior supported by Tauri.
4. Map only known custom menu IDs to one fixed `takio://menu-action` payload and emit it to the main webview. React listens once and routes actions to the same import/open/send/eject/find functions used by visible controls. Unknown IDs do nothing. Find focuses the existing search input.
5. Add a small Rust unit test for the fixed menu-ID-to-action mapping. Do not add global `keydown` handlers or a frontend menu package.

Gate: Rust and desktop automated checks pass. In the packaged Tauri app, every listed shortcut triggers exactly once, text-field Edit commands remain native, Find focuses search, and picker/drop imports share result behavior.

Micro-commit: `feat(desktop): add drag import and macOS menus`

### Phase 5 — Real hardware acceptance

Likely product files changed: none. Record results in the validation table at the end of this document.

Run the full automated suite immediately before hardware validation. Use release-equivalent packaged application behavior, not direct helper calls, for detection, Send, and Eject.

#### Kobo gate

1. Connect a Kobo that mounts under `/Volumes`; Refresh must show it as Kobo with the correct mount name/path and must not select it automatically.
2. Import a non-DRM EPUB by dropping it. Quit and relaunch; verify the item persists. Use Open and verify the default macOS reader launches it.
3. Explicitly select the Kobo and Send. Record the UI's destination path, byte count, and SHA-256. Before eject, compare `shasum -a 256` for the library-owned source and mounted copy; the values and sizes must match.
4. Eject from Takio. Verify the mount disappears, disconnect/reconnect, let Kobo import/refresh its library, and open the book on the physical device.

#### Kindle gate

1. Connect a Kindle that exposes a writable `/Volumes/...` mass-storage mount containing `documents` and `system`; Refresh must classify it as Kindle and must not select it automatically. If the available Kindle is MTP-only, stop and record the acceptance gate as blocked.
2. Import a non-DRM AZW3 or MOBI already known to open on that model. Explicitly select the Kindle and Send; verify the result targets its `documents` directory.
3. Record path, bytes, and SHA-256, then compare the library-owned source and mounted copy with `shasum -a 256` before eject.
4. Eject from Takio. Verify the mount disappears, disconnect/reconnect, refresh the Kindle library, and open the book on the physical device. Do not use EPUB here to imply conversion support.

Gate: every step passes on both readers. Any mismatch, unsafe mount choice, partial file, failed eject, missing book, or unreadable book keeps the milestone open.

Micro-commit after recording evidence: `docs: record daily-driver device validation`

## Automated gates

Run from the repository root after every relevant phase. The explicit SDK/linker values are required in the current shell because Nix `cc` is ahead of Apple's toolchain.

```sh
bun run --filter '@takio/cli' check
bun run --filter '@takio/cli' test
bun run --filter '@takio/desktop' check
bun run --filter '@takio/desktop' test
bun run --filter '@takio/desktop' build
bun run check
bun run test
bun run build
SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk \
  CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc \
  cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX26.2.sdk \
  CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=/usr/bin/cc \
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

No skipped test is a pass. The wrapper/argument tests are necessary but do not replace launching the packaged Tauri app, and fake mounted-volume tests do not replace the two physical-reader gates.

## Material risks and rollback

- **External writes:** Send writes outside the Takio library. Existing no-overwrite, confinement, temporary-file, digest, fsync, and atomic-rename behavior are mandatory. A crash may leave a `.takio-partial-*` file; report and remove only that exact verified artifact, never a broad directory.
- **Unsafe eject timing:** Ejecting during a transfer risks data loss. A single device-operation pending state and disabled Eject are release requirements, not polish.
- **Wrong-volume selection:** Generic removable volumes can be listed. Explicit selection and backend reauthorization are both required; do not infer that the first or previously mounted path is safe.
- **False Kindle compatibility:** file transfer success is not reading success. Only the physical-device open proves the chosen original is useful; conversion and MTP remain out of scope.
- **Menu regressions:** custom shortcuts can steal text editing or fire twice. Native predefined Edit items and one event listener are the rollback-safe design. If menu wiring fails, revert Phase 4 without reverting the bridge or visible controls.
- **Bridge regressions:** each phase is independently revertible in reverse commit order. Making `send --db` optional is backward-compatible; reverting it requires the desktop to gain its own database-path knowledge, so repair forward unless that CLI behavior itself is faulty.
- **Library safety:** none of these phases mutate existing records except through the current import path. Open, list, Send, and Eject must not rewrite the library. Hardware validation uses disposable, non-DRM test files.

## Validation record

Leave a failed or unavailable cell explicit. Do not replace hardware evidence with “tests pass.”

| Reader | Model / firmware | Mount path | Format | Bytes | SHA-256 matched | Ejected / remounted | Opened on device | Result / notes |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| Kobo | _pending_ | _pending_ | EPUB | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| Kindle USB mass storage | _pending_ | _pending_ | AZW3 or MOBI | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
