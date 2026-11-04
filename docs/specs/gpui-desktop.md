# Takio Native Desktop (GPUI)

Status: primary and only desktop. The Electron application was removed at the
user's request on November 3, 2026. Current completion work and its measured
gates are recorded in `../plans/2026-11-03-native-completion.md`.

## Why

The library engine is the `apps/engine` Rust crate (`takio-engine`, library name
`takio`). The CLI adapters live separately in `apps/cli`. The former Electron desktop reached it
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
   and large queries. A separate bounded reader-scan worker keeps slow USB reads
   off the catalogue request queue.
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
    Query { query: String, filters: Filters, reply: Sender<Result<Vec<Arc<LibraryItem>>>> },
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
is the same guarantee the former Electron `library service` loop provided.
Reader scanning has one running and at most one pending request, owned fingerprint
snapshots rather than a SQLite connection, and library-generation guards. Switching
invalidates old scans. Eject reports an active scan rather than unmounting beneath
an uninterruptible OS read.

Native queries reuse immutable hydrated records in a per-store cache, while still
running the existing literal SQL selection and filters every time. The cache holds
at most 10,000 items and an estimated 32 MiB of record/container/key allocations.
Oversized records are returned uncached. SQLite read transactions keep IDs,
revision checks and missing-record hydration in one snapshot. Same-connection
writes, external commits and schema changes invalidate retained records. Existing
caller transactions bypass retention. This cache never substitutes for filesystem,
fingerprint, reader availability or send-authorization checks.

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
generated 10,000-item catalogue. It opens the engine/workspace directly, excluding
remembered-library lookup and the production startup-recovery wrapper. It enforces
these median harness startup budgets:

- First paint: at most 150 ms from process startup.
- Initial full-list query completion: at most 400 ms from startup.
- RSS sampled at startup completion: at most 150,000 KiB.

The following are design goals, not measurements or gates satisfied by that
script: 120 Hz scrolling with no frame over 8 ms, search keystroke-to-list update
below 80 ms p95, and steady-state idle memory. Scrolling and interactive search
require separate sampling. Search uses an 8 ms debounce, included in interaction
measurements rather than subtracted. Its deadline starts at input and dispatches
the read on the background executor, without waiting for another foreground turn.
Superseded pending inputs are cancelled, while in-flight results retain generation
checks and background disposal.

`bash scripts/bench-desktop-native.sh --interactions` additionally exercises the
production state in a real GUI against the same deterministic 10,000-book library.
Each of five processes runs five cycles of matching search, clearing search,
sorting, and select-all/reload. The script validates counts, sort order, search
matches, and retained selections before reporting median and nearest-rank p95
from 25 samples per operation. Search timing includes the 8 ms debounce.
`dispatchMs` measures only the initiating UI call. `settledMs` ends at the result
notification. Neither measures actual keyboard-to-display latency or scrolling,
and low dispatch time alone does not prove result application meets a frame budget.
The opt-in interaction gates require title-sort dispatch p95 at most 8 ms and
select-all/reload settled p95 at most 200 ms. Sort samples retain zero selected
books on the first cycle and 5,000 search matches on later cycles. The reload
samples select and retain all 10,000 books. These gates do not certify the
separate below-80-ms search goal.

`--render-interactions` additionally injects text through the production Search
input handler and measures the next frame after settled workspace paint submission.
It also scrolls the virtualized list programmatically to the first and last rows
and checks the visible index. These are not physical keystrokes, wheel events,
GPU completion or display-scanout measurements. `TAKIO_BENCH_REQUIRE_SEARCH_TARGET=1`
makes the reported search p95 target a hard gate for the selected scope.

November 3, 2026 final local acceptance: the native gate passes with an
11,927,760-byte executable, below the unchanged 12,000,000-byte limit. Two separate
25-sample-per-operation rendered probes passed matching/clearing search at
63.216/49.969 ms and 63.273/49.956 ms p95, including first queries after startup.
One first-query outlier reached 81.776 ms, so this is a p95 result, not a maximum
latency guarantee. Startup/state budgets also pass. The completion plan records
failed intermediate runs, exact scope and remaining platform/hardware gates.
A completed hosted CI workflow on the final commit remains unverified.

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
- Opt-in automatic recovery copies: choose an existing disjoint destination,
  create a verified whole-library copy now and every 24 hours while the app is
  open, and keep all copies. No service or automatic deletion. Missing drives
  are not recreated. Failure retries are throttled and successful copies survive
  preference-save failures. Modal workflows pause scheduling.
- Startup recovery: corrupt or incompatible defaults show a usable recovery
  window. Open an existing library or restore to a new disjoint folder without
  replacing the original. Supported legacy defaults retain verified migration.
- Command palette (Cmd-K) over every action.
- Native menu bar with the same actions and accelerators.
- Light and dark appearance following the system.

Out (remain in CLI/TUI or later cuts): advanced metadata editing, candidate review,
duplicates, general conversion-job management, custom columns, saved views, export dialogs,
multi-window library sessions. Existing CLI operations remain
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
5. Build, check, package, release and version-verification entry points target the
   native app, not a removed Electron workspace. Local ad-hoc packaging must not
   be represented as notarized distribution. Signing and publishing require
   separate authorization and credentials.

## Measured result

The retired `scripts/compare-desktops.sh` launched both desktops five times against one
deterministic 10,000-book library on the same machine and reported medians.
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
