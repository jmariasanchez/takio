# Changelog

All notable changes to this project will be documented in this file.
The format follows Keep a Changelog. Unreleased changes include work in progress
and are not a claim that a published release contains every entry below.

## [Unreleased]

### Added

- Native GPUI desktop (`apps/desktop-native`): one 10.7 MB binary that links
  the Rust engine in-process. Virtualized library table, incremental search,
  facet sidebar, inspector with background cover decoding, command palette,
  native menus and file dialogs, trash, device send/eject, light and dark
  themes. On a 10,000-book library: 84 ms to first paint, 136 ms to a fully
  loaded list, 118 MB RSS (medians of five launches, enforced by
  `scripts/bench-desktop-native.sh`). `scripts/package-desktop-native.sh`
  produces a signed Takio.app.
- Local SQLite ebook libraries with explicit managed/reference ownership,
  multi-format books, rich metadata, covers, reversible trash, and duplicate review.
- Electron/React library workspace with paged tables, facets, inspectors,
  bulk actions, native dialogs, and reader delivery controls.
- Native Rust CLI and Ratatui terminal UI sharing library, conversion, jobs,
  and delivery implementations, with deterministic JSON automation commands.
- Five Calibre-backed conversion pairs and a durable foreground jobs queue with
  retries, verified outputs, and library attachment reconciliation.
- Verified mounted-reader delivery, inventory, reconciliation, safe removal,
  eject, and explicitly opted-in rooted Kindle SSH/SCP transport.
- Recursive, watched, and read-only Calibre-library imports, plus copy, move,
  reference, and journaled adoption workflows.
- Metadata extraction, optional online candidate and cover review, cancellable
  multi-book reconciliation, polishing, content search, and format validation.
- Named libraries, virtual libraries, bounded structured queries, per-book
  custom text fields, and library-defined labeled text columns.
- Read-only integrity audits, verified snapshot backup/restore, portable OPF
  export/rebuild, collision-safe organized disk exports, and catalogue publication.
- Authenticated loopback content serving and independently implemented
  TypeScript EPUB transformation utilities.
- Checksummed standalone CLI releases, desktop packaging verification, and
  library-query and native-startup performance gates.
- Dependabot for cargo, bun, and GitHub Actions.

### Changed

- Library reads hydrate items with one query per child table instead of
  seven queries per item. Listing or querying 10,000 books went from
  ~800 ms to ~135 ms end to end; the CLI query benchmark p95 dropped from
  61 ms to 35 ms.
- Replaced the Tauri desktop with Electron and the Bun CLI with one Rust
  executable used by both the terminal interface and desktop sidecar.
- Advanced library storage to schema v12 with canonical cross-runtime custom
  column definitions and verified migrations from v1 through v11.
- Serialized desktop library mutations through a persistent native service
  and accelerated large-library queries with prefiltering before hydration.
- Shared SHA-256 fingerprint module replaces eight duplicated hash loops.
- Optimized release profile (fat LTO, stripped) shrinks the CLI binary ~28%.
- Every CLI subcommand now has --help text; invalid --mode and catalog --format
  values are rejected at parse time.
- Desktop renderer ships a strict Content-Security-Policy, denies all browser
  permission requests, and blocks webview attachment.
- CI caches Rust and Bun dependencies, cancels superseded runs, and runs
  cargo audit and bun audit as a blocking job.
- Upgraded Electron from the end-of-life 37 line to 42, clearing every
  Electron and transitive advisory reported by bun audit except one
  download-time sprintf-js warning that has no upstream fix.
- Updated happy-dom to 20.14.6.

### Fixed

- Closed a race in the terminal metadata-review loader where a cancelled
  lookup could publish its result after the receiver was dropped, leaking a
  staged candidate cover. The cancel handshake is now mutually exclusive with
  the final send. The previously flaky TUI test passes 40 of 40 runs.
- Hardened initialization, migration rollback, cross-runtime schema validation,
  deferred cleanup, and backup recovery without treating legacy paths as ownership.
- Prevented destination overwrite races, preserved source artifacts during
  polishing, and corrected delivery compatibility with FAT readers and Kobo roots.
- Bounded backup, portable metadata, and authenticated server resources, and
  neutralized active catalogue content and untrusted bridge payloads.
- Corrected desktop focus, modal ownership, stale custom-column state, partial
  metadata edits, and exact-format selection across open, send, and conversion.
- Made clean-checkout builds and packaged releases more reliable through
  dependency ordering, runtime checks, executable archive preservation, and DMG validation.
