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
with a next step rather than silently sending unreadable bytes. Explicit
single-book EPUB-to-AZW3 preparation is available in the desktop when Calibre is
present and reviewed by the user. Sending never automatically converts a book.

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

- Finish the on-device reading check for the physical-reader acceptance run below.
  Native import, review/cancel, verified USB transfer, duplicate refusal, and safe
  eject now pass on the connected Kindle. Its screen remains unobserved.
- Improve measured search-tail latency without changing literal search semantics.
  The performance iteration below establishes a reproducible baseline. Measure
  actual input-to-display and scrolling separately before claiming those goals.
- Validate prepared EPUB/AZW3 books on the physical reader. Native single-book
  preparation, backend discovery and explicit conversion controls now pass the
  real-book Mac-side acceptance below. Calibre remains an external dependency.
  Batch conversion and persistent conversion-job management remain out of scope.
- Add reference-in-place import and missing-file recovery if real library use
  shows these are needed. Preserve caller ownership.
- Decide whether MTP is needed from actual reader demand, not from simulated
  mounted-volume tests or this one USB mass-storage Kindle.

Only expand this list when an observed core-workflow problem justifies it.
Acceptance evidence for each implemented slice belongs below, with commands and
limitations rather than speculative completion claims.

## Native EPUB preparation: October 22, 2026

The user approved continuing the missing product work and explicitly offered
existing EPUBs on the Mac for validation. This slice prioritizes real EPUB handling
and the missing local preparation action, rather than claiming to implement all
future recovery, performance, transport, and accessibility work at once. Personal
files may be read and copied for the requested tests, never moved, modified,
uploaded, or committed. Three size-diverse EPUB copies are isolated in session
scratch storage; a private baseline records original hashes, sizes and mtimes.

The smallest coherent action is **Prepare for Kindle** for one selected EPUB:
review EPUB-to-AZW3 preparation and detected converter, then explicitly Convert or
Cancel. A connected reader is not required to prepare a library attachment.
The conversion runs on the engine thread using the existing conversion backend
and verified-artifact attachment API. The source EPUB remains attached and
unchanged. Sending remains a separate review and confirmation, never a conversion
side effect. No automatic installation or DRM removal is added to the product.

Requirements and checks for this slice:

- Menu, command palette and visible book action open the same read-only review.
  Cancel, including a pending preview, creates no attachment or conversion output.
- Backend discovery occurs off the UI thread. Missing or non-executable backend
  produces setup guidance, disables confirmation, and does not pretend conversion
  succeeded. Validation uses an official signed converter copied to scratch only.
- Confirmation binds the original item, source path/fingerprint, output AZW3 and
  converter path. Selection changes cannot redirect it. Changed/trashed/missing
  sources, existing AZW3 and stale backend must fail without replacing anything.
- Conversion operates on a private copy, uses a bounded timeout, validates a
  nonempty regular output, and calls verified managed attachment publication.
  Failure retains EPUB, reports an actionable error, and cleans private stages.
- Busy/review state blocks conflicting mutation/send/eject and duplicate confirm.
  Completion refreshes formats with an honest prepared-but-not-sent result.
- Native state/window tests cover these branches; real packaged-app import,
  review/cancel, unavailable backend, approved conversion, restart persistence,
  public CLI integrity and original hashes provide end-user boundary checks.
- Real converted artifacts are checked with the converter's own parser and local
  roundtrip inspection where supported. This does not replace opening a book on
  the physical Kindle, which is currently safely ejected and unavailable.

### Observed preparation results

Implementation commit: `844772c`. The rebuilt, ad-hoc signed `dist/Takio.app`
completed real-book acceptance from 12:40 to 12:52 UTC. Personal book names and
content are not included here. The three samples were selected from local EPUBs
by size and copied to an isolated profile, not imported into the user's real
library. No reader was mounted and no hardware write was attempted.

| Requirement / changed output | Concrete check and observed result |
| --- | --- |
| Native copy import | File > Import > Add books imported all three real EPUB copies. Status: `Imported 3, skipped 0, failed 0`. Public CLI `library list` and `library verify` showed three active managed EPUBs. |
| Visible action, menu, shortcut and palette | Reader > Prepare for Kindle, Cmd-Shift-P, the actual toolbar hitbox, and the command-palette Prepare command each opened the captured book's review in the signed app. |
| Missing backend | Launch without the override displayed installation/full-path guidance. Invoking native menu confirmation created no attachment. Cancel removed the review. CLI and original-file audits still showed exactly three EPUBs and no preparation stage. |
| Available backend, read-only review | With the signed scratch converter, review displayed its exact resolved executable path, EPUB-to-AZW3, source-preservation and separate-send guidance. Cmd-. canceled. Independent catalogue/file checks still showed no AZW3 or staging output. |
| Consent binds the reviewed book | Opened sample-01 review with the toolbar, changed table selection, then clicked Convert to AZW3. Only sample-01 received the new attachment. The other two retained only EPUB until their own explicit confirmations. |
| Real conversion and publication | All three independent confirmations completed with `AZW3 prepared. EPUB kept. Review send when ready.` Public verification showed six managed formats across three active books. No private staging directories remained. |
| Original preservation | After import, cancellations, each conversion, repeat refusal and restart, SHA-256, byte size and modification time of all three original files matched the pre-test baseline. All isolated inputs and managed EPUB hashes also matched. |
| No overwrite | Repeating preparation for an already-prepared book displayed existing-AZW3 guidance. All three output hashes and six managed attachments remained unchanged. |
| Persistence | Normal Quit and relaunch without a converter retained all three EPUB/AZW3 pairs. Public CLI integrity checks still passed. The compact table ellipsized the format list at the tested 900-point width, so the public catalogue independently verified complete format IDs. |
| No implicit send | Preparation did not create a transfer result. Explicit Send afterward displayed `Connect a USB reader, then use Refresh readers`. `/Volumes` contained only the Mac system volume. |
| Output is parseable, not merely nonempty | Calibre's real `ebook-meta` parsed each native-produced AZW3. Its real `ebook-convert` roundtripped each to a new EPUB. ZIP CRC, container/OPF, every spine reference and text extraction passed. All original unique words were present in each roundtrip. This is not a visual or on-device reading test. |
| Failure and overlap safety | The final native suite exercised pending cancellation, stale replies, missing/changed/trashed source, changed backend, existing attachment, output collision, failed/empty/symlink output, timeout, duplicate confirm, close/mutation/send/eject guards and failure messaging. These controlled failure checks use isolated source fixtures and fake executables, not physical reader or real-backend timeout evidence. |

Real artifact observations:

| Sample | Original EPUB bytes | Managed AZW3 bytes | Original / roundtrip spine entries | Original / roundtrip word tokens | Original / roundtrip images |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 627,169 | 946,162 | 83 / 83 | 132,927 / 132,927 | 9 / 9 |
| Medium | 2,128,340 | 2,288,805 | 21 / 22 | 81,529 / 81,602 | 6 / 6 |
| Large | 13,280,031 | 13,997,376 | 28 / 28 | 90,897 / 90,897 | 1,096 / 1,096 |

The medium EPUB contained an encryption descriptor. The initial audit expected
its conversion might fail, but the unmodified official backend succeeded. The
expected attachment set was corrected to this observed result. An encryption
descriptor alone is not proof of unreadable DRM-protected content. No DRM-removal
plugin, bypass or source modification was used. Its roundtrip added one spine
entry and 73 word tokens, so this is not claimed to be a byte-identical or
structure-identical conversion.

Reproduction uses an isolated `root`, three caller-owned EPUB copies, and a local
Calibre executable. Launch the signed app first without, then with,
`TAKIO_EBOOK_CONVERT` and use the native steps in the table. The public audit
commands are:

```sh
TAKIO_DATA_DIR="$root/library" dist/Takio.app/Contents/MacOS/takio-desktop
# Quit normally before relaunching with the reviewed local converter.
TAKIO_DATA_DIR="$root/library" TAKIO_EBOOK_CONVERT="$converter" \
  CALIBRE_CONFIG_DIRECTORY="$root/calibre-config" \
  dist/Takio.app/Contents/MacOS/takio-desktop

target/debug/takio library list --db "$root/library/library.sqlite"
target/debug/takio library verify --db "$root/library/library.sqlite"
# Parse each returned managed AZW3 without modifying it, then roundtrip into a new path.
"$calibre_bin/ebook-meta" "$managed_azw3"
"$converter" "$managed_azw3" "$new_roundtrip_epub"
```

The private session baseline and read-only audit scripts retain the exact original
hashes and output hashes outside the repository. An early audit incorrectly used
an extra `library` path component and treated the JSON `value` object as the item
array. It stopped rather than passing. After correcting the native database path
and reading `value.items`, every audit above passed against the actual app's data.

### Final gates and remaining boundaries

- `cargo fmt --all --check`: pass.
- `cargo test --offline --workspace`: **286 passed**, comprising 118 library,
  57 CLI, 2 custom-column integration and 109 native tests. Two existing benchmark
  tests remain ignored. All 24 native workspace-window tests passed, including
  five new pointer/action preparation tests using the real worker and store.
- `cargo clippy --offline --workspace --all-targets -- -D warnings`: pass.
- `git diff --check`: pass.
- `bash scripts/package-desktop-native.sh`: pass, strict ad-hoc signature valid,
  11,117,873-byte bundle, isolated packaged startup and all three interactive
  launches exited 0. The single packaging smoke sample was 171.522 ms first paint,
  236.635 ms query and 93,760 KiB RSS. This is not a rerun of the five-sample 10k
  performance budget, nor proof of interactive search/scrolling targets.

The first full-suite and release-build attempts ran out of disk space. Only
regenerable Rust incremental caches and this session's downloaded installer were
removed. The unchanged implementation then passed the complete suite and build.
No personal library files were removed to free space.

Independent review found and prompted fixes for bare-name converter resolution
and two raw failure messages. Discovery now resolves qualified executable
candidates to absolute canonical paths before review, preserving env/PATH/bundle
precedence. Regressions prove that a different child PATH or working directory
cannot redirect the approved converter. Managed-file collisions and post-review
Trash changes now give preservation/re-review guidance. Starting preparation also
clears stale transfer results.

Calibre 9.16.0 was downloaded from its official distribution, verified with macOS
signature/notarization checks, and copied only into scratch for this validation.
It was not installed in Applications or bundled into Takio. Normal use still
requires a discoverable local Calibre installation or explicit executable path.
The backend is pinned by resolved path, not executable content hash. Native output
validation guarantees regular/nonempty verified bytes, not complete AZW3 semantic
validation for arbitrary backends. The shared converter's process-grandchild
termination and the store's cross-process publication races remain preexisting
boundaries, not claims resolved by this slice.

**Physical EPUB/AZW3 rendering and the earlier Kindle reading checkpoint remain
unobserved.** The Kindle is safely ejected. No Mac-side parser, roundtrip or native
state test closes that external gate. Search-tail latency, scrolling/accessibility
measurement, missing-reference recovery and MTP remain separate product work.

## Physical Kindle acceptance: October 22, 2026

The user connected a Kindle and authorized completing the product workflow.
Interpretation: this permits adding one uniquely named disposable test document
and its delivery record through the app, not changing existing personal books,
reader settings, or accounts. Opening the resulting book on the Kindle screen
still requires a user observation, which cannot be inferred from Mac-side hashes.

Read-only discovery found a physical USB FAT32 volume at `/Volumes/Kindle`, with
KOReader detected, 204 existing document files, and 146 existing delivery records.
The isolated test library and TXT source are under a session scratch directory.
A private local baseline records existing document sizes/mtimes and the full
manifest. Personal filenames and records are not copied into this repository.

Acceptance sequence recorded before any device write:

1. Import the unique test source through the packaged app's native picker.
2. Review TXT readiness, cancel, and independently confirm no new document or
   changed manifest bytes. Repeat review and explicitly send only this test book.
3. Independently compare the copied bytes/hash, preserve the 146 prior records,
   and verify all 204 prior document sizes/mtimes are unchanged. This metadata
   check is not a full content-hash audit of the user's existing books.
4. Repeat the send and observe a no-overwrite failure, with the successful copy
   and manifest unchanged. Eject through the app and verify the mount disappears.
5. Ask the user to open the test book and report its visible reading checkpoint.
   Leave this gate incomplete until that observation arrives.

Pre-transfer safety review found that manifest replacement explicitly removed
its predecessor before publishing the staged replacement. The shared engine now
stages and syncs, then renames over the predecessor without pre-deletion. Failed
staging/publication attempts clean the stage on a best-effort basis, and a failed
publication leaves the predecessor in place. Regression checks cover 146 retained
records, injected publication failure preserving exact prior bytes, and a
malformed prior manifest remaining untouched. This does not certify crash or
power-loss durability on every filesystem.

### Observed physical results

The rebuilt, signed `dist/Takio.app` completed this run between 11:43 and 11:47 UTC:

- Native File > Import > Add books imported the single disposable TXT into an
  isolated managed library. Independent CLI `library list` and `library verify`
  confirmed one active managed item, schema 12, with the original source retained.
- Reader menu > Send Selected Books > Kindle displayed `1 ready, 0 need attention`
  and `Ready as TXT`. Preview and Cancel left the exact manifest bytes and all
  prior document metadata unchanged. The actual sidebar button opened the same
  review, also without writing. Explicit native confirmation performed the send.
- The app displayed `Sent 1 to Kindle, 0 failed, 0 not sent` and `Sent and verified`.
  Independent comparison found the 617-byte destination identical to the original,
  SHA-256 `6e83be157f6da7da6056e757a96c794185e6ce8b4e7aa28e20fe14c520e9ee1a`.
  All 146 original delivery records remained semantically identical, with exactly
  one new record, and all 204 existing document sizes/mtimes remained unchanged.
  No transfer stages or manifest temporary files remained.
- The initial audit expected exactly one added directory entry and correctly
  stopped when it found two. Investigation identified the exact test filename
  plus its 4096-byte `._` AppleDouble companion (header `0005160700020000`).
  The check was refined to permit only this explicitly verified companion, not
  arbitrary additional files. Neither it nor any existing reader file was deleted.
- Repeating the real send produced `A file with that name already exists on the
  device` and `Sent 0 to Kindle, 1 failed, 0 not sent`. Independent before/after
  checks proved exact manifest bytes, test-file hashes and metadata were unchanged.
  Readiness describes compatible format/source, not a promise of collision-free
  delivery. The review explicitly says existing reader files are never overwritten.
- Reader > Eject Reader > Kindle displayed `Ejected Kindle`. The app's process
  logged successful disk ejection, `/Volumes/Kindle` disappeared, and an independent
  CLI `destination list` returned an empty list. Normal app Quit returned exit 0.

The test book `Takio Reader Check 2026-10-22 aiKwWS` remains on the Kindle for the
user to open. The requested visible checkpoint is `TAKIO-READS-20261022-AIKWWS`.
**On-device readability is still pending user observation.** This run validates
one physical KOReader-equipped, USB mass-storage Kindle and TXT delivery. It does
not certify stock-reader EPUB support, other transports, conversion, or rendering
of other ebook formats. These current results supersede earlier hardware-absent
notes below, without rewriting their historical observations.

Validation of the shared-engine change: `cargo fmt --all --check`,
`cargo test --offline --workspace` (258 passed, two intentionally ignored
performance reports), `cargo clippy --offline --workspace --all-targets -- -D warnings`,
and `git diff --check` passed. The counts are 114 library, 57 CLI integration,
two custom-field integration, and 85 native tests. The three added manifest
regressions are included. The release bundle passed strict code-signature
verification and a real startup smoke test, at 11,034,961 bytes. Cargo still
reports the pre-existing future-Rust compatibility notice for `block 0.1.6`.
The separate five-run, 10,000-item `bash scripts/bench-desktop-native.sh` gate
passed: median first paint 93.131 ms, first query 146.889 ms, and RSS 124,256 KiB.
The single empty-library packaging smoke run had first paint 316.657 ms and
query 410.866 ms. That cold smoke run is not the defined five-run median gate,
and neither measurement certifies scroll frame times or search input-to-paint.

### Whole-result audit after physical acceptance

At 11:51 UTC the scope was rechecked against the two explicit requests: focus on
the product, then continue with the connected Kindle. Selecting pre-send review
rather than strategy work was an inference, as was treating "all done" as the
bounded core journey rather than every item in the future roadmap. The later
Kindle request makes physical acceptance the immediate priority, but does not
retroactively prove approval of every earlier product choice. Review, captured
format/source consent, and manifest preservation all serve that same journey.
The manifest fix was necessary follow-through before adding a record alongside
146 existing ones, not authorization to modify personal books or reader settings.
No incompatible pre-scope change was found that needed reverting. No automatic
conversion, account access, device configuration, or unrelated expansion was added.

The entire committed result was rerun, not just the three new tests:
`cargo fmt --all --check`, `cargo test --offline --workspace` (258 passed, two
intentionally ignored), strict workspace/all-target Clippy, `git diff --check`,
and strict bundle signature verification all passed again at 11:51 UTC. Every
repository test named in the earlier whole-product matrix below ran in this
suite. A read-only name-to-log cross-check found all 45 distinct named checks
across that matrix and this audit recorded as passing, with none missing.
A fresh five-run startup gate at 11:53 UTC passed with medians of 106.270 ms
paint, 158.394 ms query, and 124,128 KiB RSS. The release and packaged executable
have the same Mach-O build UUID and code-section hash. Whole-file hashes differ
because bundle signing replaces the linker signature with the app signature.

The production signed app was also restarted with the actual isolated physical-
acceptance library. The native menu selected the persisted test book, and Send
Selected Books displayed `Connect a USB reader, then use Refresh readers`.
Independent public CLI calls returned one active managed TXT, valid schema and
library integrity, and zero destinations. `cmp` confirmed original and managed
bytes remained identical. `/Volumes/Kindle` remained absent. Normal Quit exited
0. This was an actual app/public-interface recovery check, not a test stub.

| Requirement / changed output | Current-result check and observation | Acceptance boundary |
| --- | --- | --- |
| Native add and durable catalogue, originals preserved | Actual picker import in the physical run, followed by this production-app restart and public CLI `library list` / `library verify`; one managed TXT persisted and `cmp` passed. Whole-suite import/search/edit/trash tests also passed again. | Disposable source and isolated library only. |
| Read-only compatibility review from both entry points | Actual Reader chooser and sidebar displayed one ready TXT with nothing sent. Physical preview/Cancel preserved exact original manifest bytes. Rerun `preview_reports_ordered_readiness_without_writing` and both sidebar pointer tests passed. | Physical one-ready selection, plus native integration coverage for other selections. |
| Fresh capability/source checks and compatible formats | Rerun `preview_refreshes_capabilities_and_prefers_attached_formats`, `preview_rejects_unreadable_source`, and `stock_kindle_rejects_epub_even_with_stale_koreader_feature` passed. | Temporary reader directories exercise fresh detection logic, not additional hardware models. |
| Confirm only reviewed IDs, format and source path | Rerun `send_confirmation_uses_preview_ids_and_ignores_repeated_confirmation`, `send_chooser_uses_ids_captured_before_selection_changes`, and `reviewed_send_rejects_changed_preference_or_source_path` passed. Actual physical confirmation copied the displayed TXT. | File bytes are not snapshotted at review time. |
| Cancel, all-blocked, exclusions, and overlap guards | Rerun pending-preview and completed-preview cancellation, all-blocked, mixed-send exclusions, and `pending_review_blocks_mutations_and_cancel_restores_actions` passed. Actual physical Cancel wrote nothing. | Race/blocked cases use controlled native state tests. Earlier real-app mixed-selection evidence remains explicitly simulated at the reader boundary. |
| Bound work and recheck before writing | Rerun `preview_bounds_before_io_and_requires_connected_destination`, `reviewed_send_delivers_unchanged_ready_files_only_and_is_bounded`, and `confirm_send_rechecks_source_reader_capabilities_disconnect_and_collision` passed. | No deliberate disconnect during a real hardware write. |
| Honest success and failure outputs; no overwrite | Actual FAT32 send displayed one sent and verified; duplicate displayed zero sent/one failed and the collision reason. Independent exact-byte checks proved no overwrite. Rerun publication/symlink and multi-result regressions passed. | Readiness does not guarantee collision-free delivery or device rendering. |
| Preserve existing delivery history on replacement and failure | Actual FAT32 replacement retained all 146 prior records and added exactly one. Rerun all three manifest regressions: 146-record retention, injected failed publication preserving exact prior bytes with no stage, and malformed manifest unchanged. | Failure injection is a unit boundary; real successful replacement was separately exercised. No power-loss durability claim. |
| Preserve existing reader documents | Physical before/after comparison retained all 204 prior file sizes/mtimes. Only the test TXT and identified AppleDouble companion appeared. | Existing personal content was not read or fully hashed. |
| Eject and recover when absent | Actual native eject removed the mount and discovery. This audit's production restart/send showed actionable reconnect guidance, not success. Independent CLI again returned no destinations. | Ejection already completed; the audit did not remount or add more test files. |
| Deployable native result and bounded startup | Repeated strict signature check, actual production restart/normal exit, all 85 native tests and five-run 10k startup gate passed. | Accessibility completeness, scrolling and input-to-paint latency remain unmeasured. |
| Readable book on Kindle screen | Test document is available with the stated checkpoint, but no user confirmation or device-screen photo has arrived. | **Externally blocked, not passed.** No Mac-side hash or simulated test closes this requirement. |

The new physical observations establish that the review/no-overwrite/manifest/eject
flow works on actual USB FAT32 hardware, not merely reader-shaped directories.
The observed improvement from the earlier before/after comparison remains the
ability to see compatibility and cancel before any copy. The manifest-failure
regression now demonstrates retained prior bytes at the publication failure
boundary rather than relying on inspection of the new rename call. These are
specific correctness improvements, not evidence of user preference, broad Kindle
compatibility, or complete product-roadmap delivery.

No physical send was repeated during this audit because the device had been
safely ejected and the user was asked to read it. The 11:43-11:47 physical run used
the same executable code being audited, so its observations remain applicable.
The screen check is deferred from executable session tasks to prevent automated
retry loops, but remains an open product acceptance gate here. That administrative
deferral does not convert a missing observation into a passing result.

## Product iteration: review before sending

Interpretation audit: the explicit request was to focus on the product. Choosing
an implementation task rather than a product-strategy discussion, and prioritizing
pre-send review over the remaining search-tail work, were agent interpretations,
not user-confirmed priorities. The existing roadmap and blocked physical-reader
gate support this bounded choice, but do not establish that it is the user's
preferred next feature. Before selecting it, work consisted only of repository,
plan, and acceptance-evidence inspection. No earlier product changes needed to be
reconciled or reverted. This slice stays inside the documented add/find/organize/
send journey, adds no new transport or automatic conversion, and does not claim
to resolve broader product strategy or demonstrate user satisfaction.

The next product slice addresses a visible gap in the existing send flow:
incompatible formats are explained only after a send attempt. Before any reader
write, show a read-only review of the captured selection and chosen reader, with
the attached format for each ready book and a reason for every blocked book.
Offer explicit Send ready and Cancel actions. Never convert automatically.

Acceptance checks, recorded before implementation:

- Native menu and sidebar send actions both open the same review. Preview and
  Cancel leave source files, reader files, and the delivery manifest unchanged.
- A mixed selection shows ready and blocked counts. Confirmation sends only the
  captured ready IDs, even if selection changes, and reports excluded books
  separately from transfer failures. All-blocked selections cannot send.
- Detection and source checks happen on the engine thread. Preview uses fresh
  reader capabilities, not cached sidebar data. Actual sends still reauthorize,
  verify copied bytes, reject trashed books, and refuse overwrites.
- Tests cover disconnects, source loss, collisions after preview, cancellation,
  stale selection, and repeated clicks. Use temporary reader-shaped directories,
  not physical hardware. Run native tests, formatting, strict native Clippy, and
  exercise the app where the environment permits.

This is the first part of explicit format preparation, not a conversion UI.
Backend discovery and user-approved conversion remain follow-up work. Search-tail
latency and physical-reader acceptance remain open, not displaced or completed.

### Observed acceptance: 2026-10-22

The completed slice adds read-only review to both send entry points, with a
scrollable per-book list, explicit Send ready/Cancel, and keyboard/menu/palette
access. Blocked books are retained in transfer results separately from failures
of attempted copies. Pending review blocks mutations and eject. Cancellation and
section changes invalidate late preview replies. Confirmation uses the original
reviewed IDs, not the current selection.

Independent review found that reselecting a preferred format during confirmation
could silently send a different attachment than the one displayed. The confirmed
request now retains the reviewed format and source path. Fresh authorization and
attachment checks reject a changed preference/path with a re-review message.
Preview does not snapshot file bytes or promise available space, collision-free
delivery, or physical readability. Actual copies retain verification and
no-overwrite protection. No shared Rust engine behavior or CLI interface changed.

Automated gates:

- `cargo test -p takio-desktop`: 85 passed, including 18 additional tests for
  preview, source checks, cancellation, changed attachments, and native controls.
  Pointer tests click the real sidebar, Cancel, and Send ready hitboxes.
- `cargo test --workspace`: 255 passed (111 engine, 57 CLI, 2 custom-field,
  85 native), with the two existing manual benchmarks ignored by default.
- `cargo fmt --all --check`, `git diff --check`, and
  `cargo clippy -p takio-desktop --all-targets -- -D warnings`: passed.
- `bash scripts/package-desktop-native.sh`: strict ad-hoc signature verification
  and isolated startup passed. Bundle size: 11,034,961 bytes.
- `bash scripts/bench-desktop-native.sh`: five 10,000-book starts passed existing
  budgets. Median paint 98.674 ms, query 157.185 ms, RSS 124,240 KiB. Log:
  `$JCODE_SCRATCH_DIR/takio-send-review-startup.log`. No new interactive latency
  or scrolling claim is made.

The signed app was exercised from 11:00 to 11:05 UTC against
`$JCODE_SCRATCH_DIR/takio-send-review.s6FhNv/library`. A disposable 20 MiB HFS+
disk image, mounted as `TakioReview-s6FhNv`, supplied `documents` and `system`
directories for normal production reader detection. This was not real hardware.

1. File > Import selected the disposable inputs folder through the native picker.
   The app reported two imports, no skips/failures, and preserved both originals.
2. Sidebar Review opened a one-ready/one-blocked review: TXT ready, EPUB blocked
   with guidance. Independent filesystem checks found no documents or manifest.
   Reader > Cancel Send Review still left both absent.
3. Reader > Send Selected Books opened the same review through the native chooser.
   After changing selection to the blocked EPUB, Cmd-Enter still sent the reviewed
   TXT only. Visible results said "Sent and verified" and "Not sent (blocked in
   review)". Summary: one sent, zero failed, one not sent.
4. Independent comparison found the delivered TXT byte-identical to its original.
   The manifest contained exactly one 46-byte TXT record with SHA-256
   `9ec56d6820e224a7ccdc7d11ffbc8ab9ccf5f44772323eba7d16204c41bd343e`.
5. A second review of the EPUB alone showed zero ready. Confirmation through the
   native menu wrote nothing. Cmd-. cancelled. The manifest and documents stayed
   unchanged.
6. Native Eject successfully unmounted only the disposable image. Normal Quit
   exited with code 0. A separate CLI process verified two active managed books,
   no Trash, and intact fingerprints. Original bytes also matched the exact
   fixtures after app exit. No personal books or physical reader were modified.

### Feedback-loop recheck: observed improvement, not just passing tests

At 11:13 UTC, one identical observer drove the production `LibraryState` send
entry point against two archived revisions: `19999ca` (before) and `3369d11`
(after). Each run created a fresh library containing the same TXT and EPUB bytes,
selected both books, and invoked the same initial send action against an isolated
stock-Kindle-shaped directory. The observer adds no replacement engine logic.
Source-byte comparisons against Git confirmed both engine/state implementations
were their respective committed versions.

| Observation after the same initial action | Before | After |
| --- | --- | --- |
| New reader documents | 1 | 0 |
| Delivery manifest created | Yes | No |
| Completed send results | 1 sent, 1 failed | No transfer attempted |
| Feedback available to the user | Failure after the compatible book was already copied | 1 ready, 1 needs attention, nothing sent yet |
| Original bytes and independent library verification | Intact; 2 active books | Intact; 2 active books |

The observed improvement is an opportunity to review compatibility and cancel
before any copy, rather than learning about the blocked book only after the mixed
send. It intentionally adds a confirmation step. The old direct Send action was
authorized behavior, not an unauthorized write. This comparison does not claim
that the added step is faster or preferred by users.

The comparison probe runs real production state/engine code inside the native
test harness, not physical mouse input. The signed-app run above separately
observed the actual sidebar/menu/keyboard workflow: Cancel wrote nothing, explicit
confirmation copied the originally reviewed TXT despite changed selection, and
the blocked EPUB stayed out of the reader. At 11:14 UTC, a fresh read-only remount
of that live run's ejected disk image still contained exactly one 46-byte TXT,
matching the expected original bytes and original manifest hash/timestamp. No EPUB
or extra manifest record appeared. Both original files and the independently
reopened library remained intact. The read-only image was detached afterwards.

Reproduction artifacts are in
`$JCODE_SCRATCH_DIR/takio-product-comparison.SrthGt`: `feedback_probe.rs`, archived
`before`/`after` source trees, fresh `before-library-verified` and
`after-library-verified` fixtures, and `before-verified.log`/`after-verified.log`.
Each probe invocation uses `TAKIO_FEEDBACK_LIBRARY=<new fixture path>`,
`TAKIO_EXPECT_REVIEW=0` or `1`, and
`cargo test --offline --manifest-path <snapshot>/Cargo.toml --target-dir <repo>/target -p takio-desktop-feedback-before`
(or `takio-desktop-feedback-after`)
`feedback_probe::product_send_feedback -- --exact --nocapture`.

The first comparison attempt was discarded: a shared Cargo artifact identity
reused the baseline executable for the after snapshot. Distinct snapshot package
names forced independently compiled executables, whose paths and 67/85 other
test counts were checked. Both fresh reruns passed, followed by independent
filesystem, manifest, and CLI assertions of the table above. The normal workspace
test target was then rebuilt: all 85 native tests, strict native Clippy, formatting,
and diff checks passed again. Production source bytes are unchanged by this
recheck. The feedback loop is closed for the bounded review-before-send behavior,
not for the unconfirmed feature priority, physical Kindle readability, conversion,
or broader user satisfaction.

## Performance iteration: 2026-10-22

The requested speed and simplicity work targets the existing Rust/GPUI desktop,
not a Rails application. Keep the add, organize, find, and send workflow intact.
Do not introduce automatic moves, a watcher, or a new background service.

Observed gaps and checks to run before claiming improvement:

- Selection reconciliation currently scans a vector of selected IDs for every
  result row. Measure select-all followed by sorting and reloading a generated
  10,000-book library. Replace quadratic matching without losing the primary
  selected book, including when results disappear or asynchronous replies race.
- Query completion currently sorts and builds facets on the UI thread, despite
  the native specification. Measure state-action dispatch and settled-result
  latency in the real GUI, including search's debounce. Keep expensive result
  preparation off-thread, preserve visible results while loading, and reject
  stale replies. Exercise rapid sort/search/section changes in native tests.
- Audit shared-store search and Trash reads for repeated per-book SQL queries.
  Reuse existing bulk hydration only after comparing full metadata and ordering,
  including empty results and results spanning a bulk-query chunk boundary.
- The sidebar clones all facets on every state notification even though it
  renders at most 50 values per expanded group. Avoid copying hidden values.
- Non-watch folder import fingerprints unsupported files before skipping them.
  Skip those contents without reading them, while preserving watch accounting,
  supported-book verification, copy/move ownership, and honest per-file results.

Reproducible gates: `cargo fmt --all --check`, native tests and strict Clippy,
workspace tests when the shared store changes, the existing five-start benchmark,
and an opt-in real-GUI interaction benchmark with validated result counts.
Interaction state timing is not keyboard-to-display or scroll-frame timing.
Record baseline and final measurements below. Physical reader acceptance remains
blocked without hardware and is not inferred from any performance test.

### Measured performance slice

Before/after release measurements on this machine, using disposable data:

| Operation | Before median | After median | Scope |
| --- | --- | --- | --- |
| Native title sort, initiating UI call | 66.789 ms | 0.023 ms | 10,000 rows, typically 5,000 retained selections |
| Native title sort, settled state | 66.790 ms | 0.564 ms | Same workload, asynchronous preparation included |
| Native select-all then reload | 134.786 ms | 42.881 ms | All 10,000 selected IDs retained |
| Native matching search | 159.838 ms | 93.037 ms | 5,000 matches, includes unchanged 60 ms debounce |
| Native clear search | 177.279 ms | 109.840 ms | 10,000 results, includes debounce |
| Store `search` | 237.142 ms | 44.472 ms | 10,000 books, half with rich metadata |
| Store `list_trash` | 230.440 ms | 36.765 ms | Same catalogue, all trashed |

The native workload is `bash scripts/bench-desktop-native.sh --interactions`:
five processes, five cycles each, 25 samples per operation. Sort dispatch p95
fell from 67.281 ms to 0.035 ms; all-selected reload p95 fell from 136.110 ms to
43.927 ms. The first sort in each process has no selection, later sorts retain
the 5,000 search matches. A separate native test covers 10,000 selected rows and
primary-book identity. These are state-notification timings, not physical input
or frame-presentation measurements.

Search tail latency remains a limitation: matching-search p95 was 293.002 ms
after the change, clearing-search p95 was 204.012 ms. The below-80-ms interactive
search design goal is **not** satisfied. Startup budgets still passed: median
paint 99.237 ms, initial query 152.488 ms, startup RSS 124,240 KiB. The comparable
baseline RSS was 118,512 KiB, so this trades some memory for immutable snapshots
and responsive updates, remaining below the 150,000 KiB startup budget.

The store workload is
`cargo test -p takio --release --lib benchmark_search_and_trash_hydration -- --ignored --nocapture`.
It performs three warmups and 20 measured reads per operation. Search p95 fell
from 247.809 ms to 44.818 ms; Trash p95 from 239.791 ms to 37.199 ms. The SQL
selection, literal escaping, ordering, and errors are unchanged. Only hydration
reuses the existing bounded bulk reader rather than issuing child-table queries
for every book. These store numbers exclude GUI, process startup, and JSON output.

New native regressions cover visible rows during sorting, shared book metadata,
latest selection and primary identity, rapid sort/search/section changes,
cancelled debounce, 10,000 selected rows, and disappearing selected books.
Store parity checks cover 0/1/500/501/1,001 rows, rich/empty metadata, repeated
search joins, literal wildcard escaping, Trash order, malformed formats, and
missing selected records. Native 65 tests, engine 107 tests, CLI 57 tests, and
2 custom-field tests passed, along with strict native and CLI Clippy. The store
performance test is intentionally ignored by default rather than making unit
tests depend on wall-clock speed.

A second real-GUI run with enforced interaction gates passed: title-sort
dispatch p95 0.038 ms (budget 8 ms), all-selected reload p95 44.145 ms (budget
200 ms), all 100 interaction result checks, and the unchanged startup budgets.
The old baseline's 67.281 ms sort dispatch fails the new gate. These captures
preceded the separate store optimization; the active native query already used
bulk hydration, while the shared change benefits Trash and legacy search.

### Folder imports and final automated gates

Non-watch imports now identify unsupported formats before fingerprinting their
contents. Watch mode still fingerprints them so unchanged files are suppressed
and changed content is accounted for correctly. Supported books retain their
existing duplicate checks and verified copy behavior. Unsupported files remain
untouched even in explicitly requested move mode. Missing files still fail
honestly rather than being counted as unsupported.

`cargo test -p takio --release --lib benchmark_unsupported_scan -- --ignored --nocapture`
uses generated temporary 1 KiB and 64 MiB files, with one warmup and 20 samples.
Reported median for skipping the 64 MiB file fell from 117,896 microseconds to
12 microseconds. This measures the scan call, not total folder import, supported
book copying, or process startup. Tests cover copy/move source preservation,
mixed outcomes, cancellation, persistent watch suppression and same-size content
changes. The Unix permission test exercised actual read denial on this machine:
unsupported input was skipped without reading, while watch mode reported unreadable.

Independent review found and resolved two additional performance paths: a
completed snapshot could be destroyed on the foreground executor when its waiter
was cancelled, and a second sort during an in-flight local sort reissued SQL.
Snapshot waiters now finish and dispose obsolete or closed-entity results in the
background. Consecutive local sorts reuse the loaded books. Regression tests
exercise a ready-but-not-applied obsolete result and an external Trash mutation
that must stay invisible through rapid sorts until an explicit reload.

The combined final gates passed at 10:27 UTC on October 22, 2026:

- `cargo fmt --all --check`, `git diff --check`, strict workspace Clippy, and
  `cargo test --workspace`: 237 passed (111 engine, 57 CLI, 2 custom-field,
  67 native), with the two manual performance reports ignored by default.
- Final five-start/100-interaction run: median first paint 100.961 ms, first
  query 152.933 ms, startup RSS 123,680 KiB. Sort dispatch p95 0.034 ms and
  select-all/reload settled p95 44.522 ms passed their budgets. Settled sort
  median was 0.607 ms, reload 43.034 ms, matching search 92.629 ms, clear search
  109.860 ms. Matching search p95 was 351.350 ms, so the search-tail goal remains
  open rather than hidden by the median improvement.
- `bash scripts/package-desktop-native.sh`: signed `dist/Takio.app`, strict
  signature verification and isolated startup passed, 10,969,121 bytes.

No personal library was opened or changed. A read-only `/Volumes` check still
found only Macintosh HD. No physical reader write, eject, or readability test
was possible, and none is claimed.

### Live acceptance of the performance build

The signed build from commit `31fc504` was exercised against a fresh isolated
`TAKIO_DATA_DIR` from 10:29 to 10:35 UTC on October 22, 2026. The real File > Import
panel selected a disposable folder containing Alpha/Beta/Gamma text books and an
unsupported `notes.bin`. The rendered status was "Imported 3, skipped 1, failed 0".
An independent CLI process observed three managed records and passed
`library verify`. This import used the actual native picker, not a simulated
response or CLI import.

The real list's Title header changed the order to Gamma/Beta/Alpha while the
inspector retained "3 books selected". Edit > Find and typing `Beta` narrowed the
list to one selected book and showed its inspector. File > Move to Trash moved
only Beta, confirmed independently by `library trash list`. View > Trash rendered
Beta through the changed bulk-read path. Selecting that row and File > Restore
returned it to the library. Clearing search displayed all three books in the
chosen descending order.

Final independent verification reported three active books, zero trashed, and
three managed formats. `cmp` found each managed text book identical to its
original. The unsupported file retained its SHA-256 fingerprint
`32fbd47c241cbc24f7d24a891314081dca31fa5d3948600a8c2cbd9d4a185f65`.
Normal Takio > Quit Takio exited with code 0. No personal books or reader were
modified. The disposable fixture remains at
`$JCODE_SCRATCH_DIR/takio-performance-acceptance.UWxNYc` for reproduction.

The 10,000-book performance numbers above come from the real-GUI state probe and
store microbenchmarks, not this three-book live smoke test. This run checks the
user-visible import/search/sort/Trash/restore flow and file safety, not 120 Hz
scrolling, steady-state memory, or Kindle readability.

### Independent acceptance-loop recheck

At 10:39 UTC on October 22, 2026, a fresh five-process real-GUI run repeated all
100 interaction correctness checks. A separate comparison asserted improvement
against the captured pre-change baseline, rather than inferring improvement from
the code. Both ignored release benchmarks were also rerun on fresh temporary
fixtures. Observations were:

| Requirement | Fresh observed result | Acceptance outcome |
| --- | --- | --- |
| Faster sorting without blocking the initiating UI action | Settled median 66.790 to 0.570 ms, 117.18x faster. Existing 8 ms dispatch-p95 gate also passed. | Passed asserted minimum 10x settled speedup and correctness checks. |
| Faster refresh with all books selected | 134.786 to 40.863 ms, 3.30x faster, all 10,000 IDs retained. | Passed asserted minimum 2x speedup and 200 ms p95 gate. |
| Improve typical search without shortening debounce or changing matches | Matching median 159.838 to 93.154 ms, clearing median 177.279 to 110.556 ms. | Both passed asserted minimum 1.1x improvement and exact result counts. |
| Faster shared search and Trash reads with equivalent records | Search 237.142 to 42.418 ms, Trash 230.440 to 35.026 ms. Fresh release workloads returned 10,000 correctly ordered books. | Passed asserted minimum 2x improvement, observed 5.59x and 6.58x. |
| Avoid reading unsupported import contents | Fresh 64 MiB skip median 6 microseconds versus 117,896 before. | Passed asserted minimum 100x improvement. Permission-denial and watch-accounting regressions remain covered by unit tests. |
| Preserve the completed user workflow and original bytes after app exit | A new independent CLI process found Alpha/Beta/Gamma active, no Trash, and passed `library verify`. Original and managed bytes matched the exact fixture contents, not merely each other. Unsupported contents also matched the original fixture. | Passed all assertions after normal app shutdown. |

This closes the feedback loop for the implemented performance slice: actual
production execution is faster and the tested user journey remains correct and
durable. It does not close every long-term performance goal. Matching-search p95
in this repeat was 110.904 ms, still above 80 ms. Earlier runs showed larger tails,
so that goal remains open. Physical Kindle acceptance is still blocked, and no
keyboard-to-display, scrolling, or steady-state-memory claim is made.

Repeat logs are `$JCODE_SCRATCH_DIR/takio-feedback-repeat-gui.log` and
`$JCODE_SCRATCH_DIR/takio-feedback-repeat-store.log`. The comparison checked
thresholds programmatically and exited with code 0. No production code changed
during this recheck.

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
