# Takio Native Desktop (GPUI)

Status: in progress. Supersedes the Electron desktop in `apps/desktop` once
the acceptance gates below pass.

## Why

The library engine is already one Rust crate. The Electron desktop reaches it
through a JSON sidecar, IPC, a context-isolated preload, and a Chromium
renderer: four process boundaries and ~250 MB of runtime to show a table of
books. A GPUI app links the engine directly. There is no serialization, no
process boundary, and no web stack.

Measured on the feasibility probe (gpui-pre 0.3.9, Rust 1.97.1, Apple
Silicon): a windowed hello world is a 5.3 MB binary with 71 MB RSS and
renders in under 100 ms from launch.

## Principles

1. **One process, one binary.** `takio-desktop` links `takio` as a library.
   No sidecar, no JSON on the hot path.
2. **The UI thread never touches SQLite.** A dedicated engine thread owns the
   `LibraryStore`. The UI sends typed requests and receives typed results over
   channels. Every interaction remains responsive during imports, verifies,
   and large queries.
3. **Virtualized by default.** Lists use `uniform_list`; only visible rows are
   rendered. A 100k-item library scrolls at frame rate.
4. **Minimal surface, complete behavior.** Apple-style restraint: one window,
   a sidebar, a list, an inspector, a search field, a command palette. No
   chrome that does not earn its pixels. Every action is reachable from the
   keyboard.
5. **Covers are lazy and bounded.** Thumbnails decode on a background thread
   into a size-capped LRU cache; nothing decodes on the UI thread.

## Architecture

```text
apps/desktop-native/
  src/main.rs          window, menus, keybindings, theme install
  src/engine.rs        EngineHandle: request channel to the store thread
  src/state.rs         LibraryState entity: items, selection, query, sort
  src/theme.rs         light/dark tokens (system appearance aware)
  src/views/
    workspace.rs       three-pane layout, focus routing
    sidebar.rs         sections: Library, Trash, Devices; facets
    library_list.rs    uniform_list table, columns, sort, selection
    inspector.rs       cover, metadata, formats, actions
    search.rs          query field with debounce
    palette.rs         command palette
  src/covers.rs        background thumbnail decode + LRU
```

### Engine thread

```rust
enum Request {
    Query { query: String, filters: Filters, reply: Sender<Result<Vec<LibraryItem>>> },
    Get(String, Sender<Result<Option<LibraryItem>>>),
    Import { paths: Vec<PathBuf>, mode: ImportMode, reply: Sender<Result<ImportReport>> },
    Trash(String, ..), Restore(String, ..), Remove(String, ..),
    Update { id, patch, .. },
    ListTrash(..), Facets(..), Verify(..),
}
```

One `std::thread` owns `LibraryStore` and drains an `mpsc::Receiver<Request>`.
Replies arrive on per-request oneshot channels; the UI polls them with
`cx.spawn` + `background_executor` so results land on the main thread via
`cx.update`. Mutations are serialized naturally by the single worker, which
is the same guarantee the Electron `library service` loop provided.

### State

`LibraryState` is one GPUI `Entity`. It holds the current item vector,
selection (`BTreeSet<usize>` plus anchor), query text, active facets, sort
column and direction, and a `generation: u64` that every in-flight request
carries. Results from a superseded generation are dropped. Views observe the
entity and re-render on `cx.notify()`.

Query results are sorted and counted into facets on the background executor
before the snapshot lands in state. Books are immutable `Arc<LibraryItem>` values
so a new sort shares metadata rather than cloning a whole catalogue. Sorting an
already loaded list does not requery SQLite. The old rows remain visible while
the sorted snapshot is prepared, and mutation actions wait for it to finish.
Selection is reconciled by hashed IDs, including the primary selected book and
selection changes made while sorting. Superseded snapshots cannot replace newer
queries. Replaced catalogues are released off the UI thread.

Facets are shared immutable snapshots. Sidebar rendering only copies the visible
values of expanded groups, not every facet on each selection notification.

### Performance gates and remaining goals

`scripts/bench-desktop-native.sh` measures five real GUI starts against a
generated 10,000-item catalogue. It enforces these median startup budgets:

- First paint: at most 150 ms from process startup.
- Initial full-list query completion: at most 400 ms from startup.
- RSS sampled at startup completion: at most 150,000 KiB.

The following are design goals, not measurements or gates satisfied by that
script: 120 Hz scrolling with no frame over 8 ms, search keystroke-to-list update
below 80 ms p95, and steady-state idle memory. Scrolling and interactive search
require separate sampling. The existing 60 ms search debounce must be included
in any future end-to-end input measurement, not subtracted from it.

`bash scripts/bench-desktop-native.sh --interactions` additionally exercises the
production state in a real GUI against the same deterministic 10,000-book library.
Each of five processes runs five cycles of matching search, clearing search,
sorting, and select-all/reload. The script validates counts, sort order, search
matches, and retained selections before reporting median and nearest-rank p95
from 25 samples per operation. Search timing includes the 60 ms debounce.
`dispatchMs` measures only the initiating UI call. `settledMs` ends at the result
notification. Neither measures actual keyboard-to-display latency or scrolling,
and low dispatch time alone does not prove result application meets a frame budget.
The opt-in interaction gates require title-sort dispatch p95 at most 8 ms and
select-all/reload settled p95 at most 200 ms. Sort samples retain zero selected
books on the first cycle and 5,000 search matches on later cycles. The reload
samples select and retain all 10,000 books. These gates do not certify the
separate below-80-ms search goal.

## Scope for the first cut (v1)

Product priorities follow `../plans/2026-10-22-focused-native-library.md`, not
Calibre parity. Advanced engine capabilities need not all become desktop UI.

In:
- Library list with title, authors, series, formats, added date columns;
  sortable; multi-select; keyboard navigation.
- Incremental literal search; facet filters by author, tag, series, language,
  format in the sidebar.
- Inspector: cover, every metadata field, formats with provenance, path.
- Basic details editor: title, authors, series, tags, explicit Save/Cancel.
- Actions: import files/folders (native open panel, copy or move), open in
  default app, move to trash, restore, purge, send to mounted device, eject.
- Sending starts with a read-only review of the captured selection and freshly
  detected reader. Show each ready attachment's format and each blocked book's
  reason. Explicit Send ready and Cancel actions are available in the review,
  Reader menu, and command palette. Cmd-Enter confirms, Cmd-. cancels. Confirmation
  keeps the reviewed IDs, formats, and source paths, rechecks them before copying,
  and asks for a new review if the compatible attachment changed. Blocked books
  remain visible separately from attempted-transfer failures. Preview is not a
  delivery guarantee, conversion, content snapshot, or physical readability test.
- Explicit single-book **Prepare for Kindle**: review a local EPUB-to-AZW3
  conversion and the detected Calibre executable, then Convert or Cancel.
  Cmd-Shift-P, the Reader menu, toolbar and command palette open the same review.
  Preparation preserves the EPUB and attaches a verified managed AZW3 copy. It
  does not require a connected reader, install a converter, remove DRM, or send.
  Missing converters show setup guidance and disable confirmation. Source
  fingerprints and resolved converter paths bind confirmation to the review.
  Filesystem work and the bounded 120-second conversion run on the engine thread.
- Trash section.
- Existing-library switching through File > Open Library, Cmd-Shift-O, the
  command palette and a visible active-folder header. Validate/load the selected
  folder on the engine worker before replacing the current catalogue. Cancellation
  and invalid folders leave the old library usable. Do not create, merge, migrate
  or rebase a selected library, or edit a pristine backup snapshot. Busy operations,
  metadata edits and open reviews block switching. Library identity guards reject
  stale dialogs/replies and successful switches reset search, selection and child
  views. Remember successful selections at a stable profile location, reporting
  session-only persistence failure and explicit startup fallback when unavailable.
- Manual recovery through File menu and command palette: Back Up Library and
  Restore Backup to New Folder. Explain catalogue/Trash/managed-file coverage and
  external-reference/conversion-job exclusions before native folder pickers.
  Both operations use the serial engine worker, verify copied managed bytes and
  never overwrite an existing destination. Restore creates a separate library,
  keeps the current library open and unchanged, and shows counts/location with a
  Reveal action. Picker cancellation writes nothing. Busy state blocks conflicting
  mutations and closing. This is not automatic backup, a complete installation
  snapshot or in-place replacement. Opening the restored copy is a separate
  explicit Open Library action.
- Command palette (Cmd-K) over every action.
- Native menu bar with the same actions and accelerators.
- Light and dark appearance following the system.

Out (remain in CLI/TUI or later cuts): advanced metadata editing, candidate review,
duplicates, general conversion-job management, custom columns, saved views, export dialogs,
automatic backups and multi-window library sessions. Existing CLI operations remain
available through `takio`.

## Acceptance

1. `cargo build --release -p takio-desktop` produces one binary under 12 MB.
2. `scripts/bench-desktop-native.sh` passes the three measured startup budgets
   above on a generated 10k library. This does not certify scrolling or search
   input latency.
3. Every v1 action is exercised by an integration test driving the
   `LibraryState` entity against a temp library (GPUI `TestAppContext`).
4. `scripts/package-desktop-native.sh` yields a launchable `Takio.app` with
   Info.plist, icon, and ad-hoc signature that opens a library at
   `TAKIO_DATA_DIR`.
5. The Electron app is removed from the default `bun run build` and `check`
   scripts once 1 to 4 pass; its directory is deleted in a follow-up commit.

## Measured result

`scripts/compare-desktops.sh` launches both desktops five times against one
deterministic 10,000-book library on the same machine and reports medians.
On an Apple Silicon laptop (2026-10-22):

| | Electron | Native GPUI |
| --- | --- | --- |
| Library usable (spawn to first query landed) | 420 ms | 143 ms |
| Memory, whole process tree | 324 MB | 115 MB |
| On disk | ~250 MB bundle | 10.7 MB signed .app |

Both numbers already include the bulk-hydration fix to the shared store;
before it the Electron renderer waited roughly 800 ms on the same query.

## Platform

macOS first (Metal). Linux follows via the `wayland`/`x11` features of GPUI;
nothing in the design is macOS-specific except the packaging script. Windows
is not a target for v1.

## Toolchain notes

- GPUI is consumed as `gpui-pre` (weekly snapshots of Zed's crate) plus
  `gpui-pre-platform`. Versions are pinned exactly; updates go through
  Dependabot like any other dependency.
- macOS builds require the Xcode Metal toolchain:
  `xcodebuild -downloadComponent MetalToolchain`.
- The repo's `.cargo/config.toml` already pins `/usr/bin/cc` so Apple's
  linker is used regardless of PATH.
