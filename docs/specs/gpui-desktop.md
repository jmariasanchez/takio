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

Sorting is done in the engine thread on the full result set, not in the view.

### Rendering budget

- First paint: under 150 ms from `main` on a warm cache.
- Library with 10,000 items visible and scrolling: 120 Hz, no frame over 8 ms.
- Query keystroke to list update: under 80 ms p95 on 10k items (engine
  already measures 61 ms p95 for the SQL alone; debounce at 60 ms).
- Idle RSS with a 10k library open: under 150 MB.

A `bench` binary target in the crate measures first paint and query latency
against a generated 10k library and fails above budget. CI runs it on macOS.

## Scope for the first cut (v1)

In:
- Library list with title, authors, series, formats, added date columns;
  sortable; multi-select; keyboard navigation.
- Incremental literal search; facet filters by author, tag, series, language,
  format in the sidebar.
- Inspector: cover, every metadata field, formats with provenance, path.
- Actions: import files/folders (native open panel, copy or move), open in
  default app, move to trash, restore, purge, send to mounted device, eject.
- Trash section.
- Command palette (Cmd-K) over every action.
- Native menu bar with the same actions and accelerators.
- Light and dark appearance following the system.

Out (remain in CLI/TUI or later cuts): metadata editing, candidate review,
duplicates, conversion jobs, custom columns, saved views, export dialogs,
backup/restore. These keep working through `takio`.

## Acceptance

1. `cargo build --release -p takio-desktop` produces one binary under 12 MB.
2. `scripts/bench-desktop-native.sh` passes the rendering budget on a
   generated 10k library.
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
