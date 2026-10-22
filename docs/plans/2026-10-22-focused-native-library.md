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
existing Rust destination implementation. Stock Kindle and KOReader format
preferences come from the shared engine, not UI guesses. Unsupported books fail
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

- Finish and validate the native first usable loop above.
- Make format preparation explicit: preview missing formats and offer optional
  conversion only when a compatible backend is present and the user agrees.
- Add reference-in-place import and missing-file recovery if real library use
  shows these are needed. Preserve caller ownership.
- Test a physical Kindle and decide whether MTP is the next needed transport.

Only expand this list when an observed core-workflow problem justifies it.
Acceptance evidence for each implemented slice belongs below, with commands and
limitations rather than speculative completion claims.
