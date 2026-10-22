# Focused native library

Date: 2026-10-22

## Product decision

Takio helps a person manage the ebook files they already have and get a readable
copy onto their Kindle. Native, understandable, and safe beats feature count.
This plan supersedes the Calibre competitive/gap-closure roadmaps and the broad
Seamless Library-to-Kindle Program for new product prioritization. Existing CLI
features remain supported, not removed to make the desktop simpler.

## First usable loop

1. Add files or folders using a visible native action or drag and drop. Preserve
   originals by default and report imported, skipped, and failed counts.
2. Find books through search and existing author/tag/series/format facets.
3. Edit a book's title, authors, series, and tags with explicit Save/Cancel.
   Persist changes, preserve unrelated metadata, and keep drafts on failure.
4. Move books to recoverable Trash. Restore them. Require confirmation before
   permanent deletion, tied to the exact books selected at confirmation time.
5. Refresh connected readers. Choose an explicit Send action for all selected
   books, select an attached compatible format, and report each failed book.
   Verify successful copies and never overwrite existing device files.
6. Eject only after operations finish. Explain missing devices and unsupported
   formats instead of presenting an empty sidebar or false success.

## Delivery boundary

The native first version targets mounted USB mass-storage readers using the
existing Rust destination implementation. The native engine applies conservative,
tested format preferences to freshly detected reader capabilities. Unsupported books fail
with a next step rather than silently sending unreadable bytes. Conversion is
available in the CLI but is not automatically run by this desktop flow.

MTP, Amazon-account integration, email delivery, SSH setup, collection sync,
DRM removal, a reader/editor, plugins, news, and a new conversion engine are not
first-version requirements. Amazon's Send to Kindle website can be offered as an
explicit external handoff, never represented as an integrated or verified send.

## Acceptance and evidence

Use temporary libraries and reader-shaped directories for automated tests.
Cover metadata persistence and failure, cancel/no write, source preservation,
multi-selection, mixed-success sends, incompatible formats, collisions, stale
selection/replies, and destructive-action confirmation. Exercise native controls
in the app against an isolated profile, then rebuild the release binary.

Physical acceptance remains a separate gate: connect a real Kindle, detect it,
send a compatible book, eject, and open the book on the device. Without available
hardware, record this gate as blocked, not complete.

## Next iterations, in order

- Complete physical-reader acceptance when hardware is available. The native
  platform-picker check now passes in the packaged app, as documented below.
- Make format preparation explicit: preview missing formats and offer optional
  conversion only when a compatible backend is present and the user agrees.
- Add reference-in-place import and missing-file recovery if real library use
  shows these are needed. Preserve caller ownership.
- Test a physical Kindle and decide whether MTP is the next needed transport.

Only expand this list when an observed core-workflow problem justifies it.
Acceptance evidence for each implemented slice belongs below, with commands and
limitations rather than speculative completion claims.

## Implemented and verified on 2026-10-22

- Native details editor with explicit Save/Cancel, title validation, semicolon
  author/tag lists, Tab traversal, UTF-16 input, retryable failures, and preservation
  of unrelated metadata. Normal close/quit and destructive actions are guarded
  while a draft or operation is active.
- Visible Add books, drag/drop copy import, recoverable Trash, Restore, and native
  permanent-delete/move confirmations. Confirmations retain the original book IDs
  even if selection changes. Search invalidates stale results immediately.
- Explicit Reader menu, sidebar Send/Eject controls, up to 256 selected books per
  send, fresh destination authorization, attached-format preference, per-book
  results, and actionable missing-reader/incompatible-format messages. Stock
  Kindle EPUB-only sends fail rather than claim success. An external Amazon web
  handoff never uploads files or claims delivery on the user's behalf.
- No-overwrite device publication uses atomic hard links where available and an
  exclusive verified copy on filesystems without them. Existing files and dangling
  symlinks are preserved. A crash during fallback copying can leave an untracked
  partial target; retries do not overwrite it automatically.
- Narrow windows show fitted Title/Author/Formats columns. Wider windows also
  show Series/Added. The virtualized list and inspector remain in place.

### Reproducible gates

| Check | Observed result |
| --- | --- |
| `cargo fmt --all --check` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --workspace` | 220 tests passed: 103 engine unit, 57 CLI integration, 2 custom-field, 58 native |
| `bash scripts/package-desktop-native.sh` | Signed `dist/Takio.app`, strict signature verification and launch passed; 10,952,625 bytes |
| `bash scripts/bench-desktop-native.sh` | Five real 10,000-book starts passed budgets; median paint 90.21 ms, loaded query 149.97 ms, RSS 118,960 KiB |

`views/workspace_tests.rs` exercises rendered native actions through a GPUI test
window against the actual engine and temporary files: picker import success and
cancel, search/edit/save, deletion cancel/approval, exact confirmed IDs, and reader
selection/cancel. State tests cover asynchronous completion while browsing,
multi-book partial failure, metadata persistence, busy guards, and stale selection.
Engine/device tests cover compatible-format preference, missing/disconnected and
trashed books, byte verification, bounded batches, collisions, and exclusive-copy
fallbacks. These are not physical-device tests.

### Live macOS acceptance

The packaged release was launched with an isolated `TAKIO_DATA_DIR` and a synthetic
EPUB imported via the public CLI. At 900-point window width, the book list and
inspector rendered correctly. Native menus opened Edit details; text entry, Tab
navigation through all four fields, and Cmd-S saved title, author, series, and tags.
A separate CLI process read the saved values and passed `library verify`. Both
original and managed EPUB SHA-256 fingerprints remained identical. The app quit
cleanly through its native menu. No personal library or physical reader was changed.

The earlier unbundled debug app's Go-to-path automation failure was resolved by
retesting the packaged app with a fresh isolated library. At 08:05 UTC, the real
File > Import action opened macOS's native panel. Cmd-Shift-G, ordinary keyboard
path entry, and Return selected only the synthetic EPUB. Accessibility activation
of Add books dismissed the panel and imported one managed book. No simulated
picker response or CLI import was used for this run.

A separate public CLI process found one active managed EPUB and passed
`library verify`. `cmp` confirmed that the original and managed copy were
byte-identical, and both SHA-256 fingerprints were
`8296492833153f8a44c4dc84c919cfc83945b6de27d811c7c89863bfa4b15294`.
The app exited with code 0 through Takio > Quit Takio. The fixture and disposable
library are under `$JCODE_SCRATCH_DIR/takio-native-acceptance-20261022`, with this
run's database in `picker-library/library.sqlite`. The original remained intact.

Physical Kindle send/eject/read acceptance is the remaining external gate. A
read-only check of `/Volumes` found only Macintosh HD, so no hardware transfer was
attempted or claimed. MTP and automatic conversion remain deliberately
unimplemented in the native UI.
