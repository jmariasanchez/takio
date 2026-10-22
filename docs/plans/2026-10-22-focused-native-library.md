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
| `cargo test --workspace` | Final rerun: 223 tests passed: 103 engine unit, 57 CLI integration, 2 custom-field, 61 native |
| `bash scripts/package-desktop-native.sh` | Signed `dist/Takio.app`, strict signature verification and launch passed; 10,952,625 bytes |
| `bash scripts/bench-desktop-native.sh` | Final five real 10,000-book starts passed startup budgets; median paint 87.251 ms, initial query 139.908 ms, RSS 118,944 KiB |

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

## Intent audit and requirement traceability

The original request was interpreted as a simple native manager for books the
user already owns, with organization and a practical Kindle delivery path, not
full Calibre parity. These interpretations were necessary, not explicit user
requirements:

- "Calibri" was understood to mean Calibre in this ebook context.
- "Self-autonomous self-development" means bounded implementation in the current
  session plus `AGENTS.md` guidance for future sessions. No resident agent,
  self-modifying service, or unattended schedule was installed.
- "Books already in the system" includes existing catalogue entries and local
  ebook files. Managed copy is the default, not reference-in-place import or
  scanning personal folders without permission.
- Organization means catalogue title/authors/series/tags, search, and facets.
  Editing embedded ebook metadata or Kindle collections was not assumed.
- The existing macOS GPUI app and mounted USB engine were retained. MTP,
  integrated Amazon upload, and automatic conversion were not inferred as
  mandatory first-version features. Consequently, not every Kindle or EPUB can
  use direct USB delivery in this version.

Re-auditing every session commit from `7b788b8` found that the first change,
`3580fb9`, established this focused scope before implementation commits. The
batch engine, editor, confirmations, responsive list, and shared no-overwrite
fix all support the same basic journey. The shared copy fix also protects the
existing CLI, which uses that implementation. Earlier Calibre-expansion features
were pre-existing and were not deleted. The superseded roadmap is now explicitly
marked historical to avoid a conflicting entry point.

### Concrete observed improvement

The earlier screenshots showed clipped list columns and empty-state copy. The
packaged 900-point window now displays fitted Title/Author/Formats columns and
wrapped empty-state text. More importantly, the following real journey completed
on October 22, 2026: native picker import, app restart, unmatched search showing
zero books, matching search showing one book, select the row, edit all four
fields, save, move to Trash, cancel permanent deletion, and restore. The Reader
send action then displayed "Connect a USB reader, then use Refresh readers",
not a success message.

The independent public CLI observed title `Acceptance Library Journey`, author
`Native Reader`, series `Simple Shelf`, and tags `Owned` and `To read`. After
Trash it observed zero active books and one trashed book. After cancellation the
record and managed bytes still existed. After Restore it observed one active
book and zero trashed books with all edited metadata intact. `library verify`
passed, `cmp` still found identical original/managed bytes, and normal app quit
returned exit code 0. This used the production packaged app and real native OS
controls, with disposable EPUB content rather than personal books.

An initial keyboard sequence incorrectly assumed Escape moved focus out of
Search. It only clears Search, and Edit > Select All correctly selected text.
No metadata changed in that attempt. Explicitly selecting the rendered book row
completed the normal pointer-based flow. This run does not certify a complete
keyboard-only or assistive-technology workflow.

The final build was additionally exercised with a native folder-picker import
of three disposable text books, Alpha/Beta/Gamma. An independent CLI verified
three managed records and valid fingerprints. After all three were selected in
the app, the public CLI removed only the self-created Beta record to produce a
real stale selection. File > Move to Trash moved Alpha, stopped at missing Beta,
and left Gamma active. Independent `library list`, `library trash list`, and
`library verify` confirmed those exact effects. The complete warning about
earlier changes, unprocessed later books, and reviewing the refreshed list was
visible across two status-bar lines at 900-point window width. Both remaining
managed files matched their originals byte-for-byte; all three originals remained.

This rerun fixed two concrete audit findings: batch mutation errors previously
did not disclose possible earlier commits, and disconnect-after-discovery errors
previously exposed an unexplained `unknown-destination` code. The latter now
offers reconnect/Refresh guidance and is covered by a real-engine test that
removes an authorized temporary mount. Status messages now wrap instead of being
constrained to a fixed-height single-line footer. Batch mutations still stop at
the first error and do not provide a per-book ledger. This limit is explicit,
not presented as transactional behavior.

The final whole-project gate rerun completed at 08:20 UTC on October 22, 2026,
after all code changes above: formatting, strict workspace Clippy, all 223 tests,
signed packaging/launch, and the startup benchmark passed. The later live
folder/partial-failure run exercised that exact packaged code. Documentation-only
changes after the rerun do not alter the executable.

### Requirement-to-check matrix

All named automated checks below run in `cargo test --workspace`; they are
production-repository tests, not copied implementation harnesses. GPUI test
windows and reader-shaped directories remain simulated boundaries and are not
substitutes for the live UI and physical-device checks identified separately.

| Requirement / changed public output | Check and observed result | Boundary / limitation |
| --- | --- | --- |
| Add existing books without losing originals | Real File > Import > native panel > Add books imported one managed EPUB and, separately, a folder of three text books. Public `library list`, `library verify`, SHA-256 and `cmp` confirmed persistence and identical bytes. `copy_picker_import_preserves_original_and_supports_search_edit` also passed. | File and folder picker exercised in packaged app. OS drag/drop gesture was not independently exercised live. |
| Cancel import or decline moving originals | `copy_picker_cancel_keeps_library_and_originals`, `move_warning_cancel_never_opens_picker_or_imports`, and `approved_move_still_allows_picker_cancel` passed with unchanged files/catalogue. | GPUI platform-response simulation for these branches. |
| Find and organize existing books | Actual search showed zero results for a missing title and one for `quiet-library`. `query_is_debounced_and_filters`, `facet_filter_round_trip`, and `sort_toggles_direction_and_keeps_selection` passed. | Facet/sort correctness exercised through real engine state tests, not every live mouse gesture. |
| Persist editable metadata without altering book bytes | Actual four-field editor save was read by a separate CLI process. `metadata_persists_and_reconciles_selection_after_sort`, `unchanged_draft_is_empty_and_preserves_hidden_metadata`, and `lists_use_semicolons_preserve_sort_names_and_allow_clearing` passed. | Catalogue changes only, no embedded-metadata promise. |
| Cancel/validate/recover editor drafts | `blank_title_cannot_produce_a_patch`, `native_input_traversal_and_cancel_leave_library_unchanged`, and `save_failure_keeps_draft_and_validation_never_submits` passed. | Failed-save coverage uses a missing record, not disk-full or storage-lock injection. It proves retained editable draft, not every retry cause. |
| Recoverable removal and confirmed permanent deletion | Actual Trash, native permanent-delete alert Cancel, and Restore matched independent CLI counts and unchanged file hashes. `purge_approval_uses_captured_ids_not_changed_selection` passed. | Live run deliberately did not approve purge. Approved deletion of disposable files is covered by automated tests. |
| Disclose partial trash/restore/purge failures | Actual packaged three-book Trash after external CLI removal of the middle record showed Alpha trashed, Gamma untouched, and the full wrapped warning. `partial_mutation_failures_warn_and_reload_committed_changes` repeats valid/missing/valid IDs against the real engine for all three operations. | Batches stop at first failure. This is an honest warning, not transactionality or a per-book mutation result ledger. |
| Avoid stale selection and overlapping actions | `debounce_immediately_blocks_actions_on_stale_results`, `stale_replies_are_dropped`, `mutation_completion_survives_browsing_and_rejects_double_submit`, and `metadata_editor_saves_through_window_and_blocks_library_delete` passed. | Controlled async/window tests, not stress measurements. |
| Send explicitly chosen compatible books and report partial results | `send_chooser_uses_ids_captured_before_selection_changes`, `send_chooser_cancel_writes_nothing`, `kindle_prefers_attached_azw3_over_first_epub_and_mobi`, `stock_kindle_rejects_epub_even_with_stale_koreader_feature`, `send_many_reports_each_failure_and_continues_in_order`, and `delivery_batch_is_bounded_before_any_copy` passed. | Real engine and file copies, simulated reader directories. No physical Kindle readability claim. |
| Never silently overwrite device files | `publication_preserves_a_target_created_after_preflight`, `publication_preserves_dangling_and_live_symlinks`, `exclusive_copy_fallback_verifies_bytes_and_cleans_failed_new_output`, and `existing_destination_is_not_overwritten_and_next_book_is_sent` passed. | FAT-like fallback explicitly tested, but crash/power-loss behavior is not certified. |
| Explain missing readers and protect ejection while busy | Real Reader > Send Selected Books showed reconnect/refresh guidance. `send_without_devices_explains_how_to_connect`, `disconnected_send_reports_reconnect_guidance_without_recreating_reader`, `transfer_errors_include_actionable_recovery_without_raw_codes`, and busy-eject assertion in `multi_send_reports_each_book_and_survives_reload` passed. | Disconnect regression removes a simulated mount after authorization. Successful physical eject and open-on-device remain blocked by absent hardware. |
| Native usable layout and deployable app | Actual 900-point packaged window fit columns and editor. `narrow_900_keeps_title_author_formats_visible`, `normal_1280_shows_every_column_without_overflow`, and `wide_1800_gives_extra_space_to_title_and_author` passed. Packaging verified signature and launch. | No claim of comprehensive accessibility, every window height, or all appearance modes. |
| Keep scope focused and continue safely | First commit set scope, subsequent commit audit mapped changes to this table; `AGENTS.md` requires isolated data, bounded iteration, and explicit remaining gates. | Guidance for future work, not a promise of autonomous execution after the session ends. |

The measured performance gates cover startup only. Scroll frame-time and
interactive-search p95 goals in the native specification are explicitly unmeasured.
The Amazon link is an external browser handoff: no account, upload, or delivery
acceptance was attempted, and none is claimed.
