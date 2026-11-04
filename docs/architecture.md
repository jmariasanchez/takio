# Takio Architecture

## Product surfaces

Takio has three user-facing surfaces backed by one shared Rust library engine:

1. **GPUI native desktop** for the focused graphical library workflow.
2. **Ratatui terminal UI** for keyboard-first human use.
3. **JSON CLI** for agents, scripts, skills, and power users.

The `takio-desktop` executable links the `takio` library in process. A dedicated
engine thread owns SQLite and serializes mutations. Typed requests and results
cross the UI/engine boundary, with library identities and generations preventing
stale replies from replacing newer views. The desktop has no JavaScript runtime,
JSON sidecar, preload bridge, or Chromium renderer. The Electron application was
removed in the November 3, 2026 native-only completion work.

## Workspace boundaries

| Boundary | Responsibility |
| --- | --- |
| `apps/engine` | Shared `takio-engine` package, exported as library `takio`: SQLite library, conversion queue, Calibre adapters, and verified delivery |
| `apps/cli` | `takio` executable package: Clap CLI, Ratatui interface, and content server adapters |
| `apps/desktop-native` | GPUI desktop that links `apps/engine` directly: engine thread, state entity, virtualized views, native menus and dialogs |
| `packages/core` | Reusable ebook domain schemas and format vocabulary |
| `packages/library-contract` | Runtime-neutral automation wire schemas |
| `packages/library-store-bun` | TypeScript reference and contract implementation, independent of the native desktop |
| `packages/epub-transform` | Independent TypeScript EPUB transformation library, not a Rust CLI conversion backend |
| `scripts/` | Release packaging, bundle verification, and performance gates |

## Rust executable

The `takio-engine` package exports the `takio` library. The `takio` executable
owns command-line parsing, terminal presentation, HTTP transport, and stdout
protocol envelopes. Native desktop and CLI callers import engine types from their
canonical domain paths, never through adapter re-exports or flat root aliases.

Engine modules use `foo.rs` plus `foo/` for child modules, consistently with the
native desktop. Unit tests live under their subject's `#[cfg(test)] mod tests`
namespace, inline or in `<subject>/tests.rs` and `<subject>/tests/`. The
`test-support` feature exposes shared fixture builders and disposable-library
fault injection for adapter tests, without coupling adapters to engine tables.

| Module | Responsibility |
| --- | --- |
| `cli` (executable) | Clap commands, automation service, request mapping and presentation |
| `output` (executable) | Shared CLI/service/HTTP success and typed error envelopes, stdout record writing |
| `server` (executable) | Authenticated loopback-only read-only catalogue and format delivery |
| `tui` (executable) | Ratatui interaction, rendering, and terminal restoration |
| `error` | Closed `ErrorCode` vocabulary and application results |
| `format` | Ebook format vocabulary and extension detection |
| `fingerprint` | Streaming SHA-256 byte counts and digests for owned-file operations |
| `test_support` (feature-gated) | Disposable-library corruption, provenance, legacy schema, and PDF fixtures for adapter tests |
| `library` | Catalogue domain modules |
| `library::store` | Schema-v12 SQLite catalogue and owned-file transactions |
| `library::paths` | Default, named, and explicit library path resolution |
| `library::model` | Items, authors, formats, provenance, and metadata patch wire models |
| `library::query` | Typed query requests, facets, sorting, and shared query presentation |
| `library::catalog` | Public catalogue projection and catalogue file publication |
| `library::export` | Bounded multi-item export planning and outcomes |
| `library::diagnostics` | Bounded, redacted diagnostic bundles |
| `library::portable` | Portable OPF catalogue export and verified rebuild |
| `import` | Discovery and external-library ingestion |
| `import::scan` | Recursive discovery, source validation, and per-file import outcomes |
| `import::calibre` | Read-only Calibre catalogue ingestion and per-book outcomes |
| `delivery` | Shared compatible-copy planning and verified item delivery |
| `delivery::destinations` | Mounted-volume authorization, copy, inventory, removal, and eject |
| `delivery::kindle_ssh` | Explicit rooted Kindle SSH/SCP validation, upload, verification, and publication |
| `delivery::koreader` | Read-only KOReader recognition and reading-progress parsing |
| `delivery::reader_shelf` | Reader inventory, fingerprint cache, catalogue matching, and explicit import |
| `metadata` | Embedded recognition, bounded external metadata extraction/fetching, OPF parsing, and cover publication |
| `metadata::pdf` (internal) | Bounded embedded PDF metadata and page counts |
| `metadata::candidate_cover` | Bounded staged cover artifacts, ownership checks, and lifecycle locking |
| `library::metadata_candidates` | Typed metadata candidate preparation and reviewed application (consumes the store) |
| `library::metadata_reconcile` | Bounded multi-item candidate reconciliation and cancellation (consumes the store) |
| `conversion` | Calibre discovery, planning, execution, and artifact verification |
| `conversion::executable_discovery` (internal) | Backend precedence and canonical executable resolution |
| `conversion::maintenance` | Ebook polishing and bounded text extraction |
| `conversion::prepare` | Reviewed local EPUB-to-AZW3 preparation, staged conversion, source revalidation, and verified attachment |
| `conversion::jobs` | Independent schema-v4 foreground conversion ledger |

The crate forbids unsafe Rust. SQLite is bundled through `rusqlite`, so the
standalone executable does not depend on a system SQLite installation.

## Process protocol

Every machine command writes exactly one JSON record to stdout:

```json
{"ok":true,"value":{}}
```

`library import-watch --progress` additionally writes completed-cycle NDJSON
events to stderr. Stdout still contains only its final success or failure record.

Failures use a stable code and a nonzero exit status:

```json
{"ok":false,"error":{"code":"invalid-arguments"}}
```

Machine commands keep stderr empty. Structured request values are limited to 16
KiB and can be supplied inline, through stdin with `-`, or from a file with
`@path`.

`error::ErrorCode` is the closed application-error vocabulary. `AppError` stores
that enum, exposes `kind()` for typed dispatch, and retains `code()` for stable
wire strings. Native humanizers exhaustively match the enum. Existing literal
producers use `app_error!`, which resolves only known wire literals at compile
time; dynamic producers must supply an `ErrorCode`. Unknown literals fail
compilation rather than becoming runtime fallback messages. Serde kebab-case
serialization is checked against every previous wire spelling. Per-item import,
export, reconciliation, and conversion-job failures carry `ErrorCode`, including
persisted job codes validated when loading the ledger. Import skip and duplicate
reasons are enums shared by recursive and Calibre imports. Import failures retain
the store's actual code instead of mislabeling every other failure as unreadable.

`AppError::from_io` associates an operation-specific code with a redacted IO kind.
The default IO conversion keeps `storage-unavailable` for wire compatibility,
but retains `io_kind()` for diagnostics. It never retains private paths or OS
error text. Call sites with established source, publication, or copy error codes
choose those codes explicitly and retain the same IO-kind information.

Automation clients can use short-lived CLI commands or `takio library service`,
a newline-delimited request loop that correlates every response with the caller's
request ID. This protocol remains supported independently of the removed desktop
bridge. The native desktop does not use it.

## Library storage

The default library lives in the platform Takio data directory. A validated
global `--library <name>` selector creates an isolated named library. An explicit
`--db <path>` selects a physical database for diagnostics and automation. Named
and explicit selectors are mutually exclusive.

`library.sqlite` uses schema version 12. The Rust store creates new v12 libraries,
opens existing v12 libraries, and migrates v1 through v11 with a verified,
no-overwrite backup under one locked transaction. It proves rollback before
reporting a failed migration and rejects foreign schemas and future versions.

Managed formats live below the sibling `items` directory and managed covers
below `covers`. Referenced formats remain caller-owned. Imports publish managed
copies before returning success. Move imports verify the managed copy before
removing the source. Format removal and purge delete only paths owned by Takio.

Implemented library workflows include single and recursive import, copy or move
ownership, references, list/get/search, filtered and paged queries with facets,
metadata updates, cover lifecycle, format lifecycle, trash/restore/purge, bulk
export, catalogue publication, content search, format validation, saved views,
integrity verification, complete snapshot backup, and path-rebased restore.
Shared-engine workflows also include Calibre-library import, watched import, duplicate
review and merge, portable OPF export/rebuild, bounded structured queries, and
library-defined custom text columns. Portable v2 preserves column definitions;
rebuild also accepts v1 sources.

## Terminal UI

Running `takio` in an interactive terminal opens the Ratatui workspace. Running
it without a TTY prints CLI help instead, preserving predictable script behavior.

The TUI has Library, Jobs, Devices, and Help sections. It supports Vim and arrow
navigation, search, path import, refresh, safe trash confirmation, a command
palette, small-terminal guidance, status feedback, and selected-book metadata
candidate review with explicit online opt-in and separate cover selection.
A guard owns raw mode and the alternate screen so normal terminal state is
restored on every exit path.

## Conversion and jobs

Calibre discovery checks `TAKIO_EBOOK_CONVERT`, `PATH`, and the standard macOS
Calibre application path. An explicit invalid override reports an unavailable
backend rather than silently selecting another executable. Capabilities advertise conversion pairs only when the
backend is actually available.

This Rust release supports five Calibre pairs:

- EPUB to PDF
- EPUB to AZW3
- DOCX to EPUB
- HTML to EPUB
- TXT to EPUB

Conversions run synchronously or through `jobs.sqlite`. Jobs move through
`queued`, `running`, `completed`, `failed`, and `canceled`. Startup marks an
abandoned running job failed. `run-next` claims one oldest job and `drain`
processes a caller-bounded number in the foreground. Successful artifacts record
their path, byte count, and SHA-256 digest.

## Mounted destinations

Destination discovery is an explicit mounted-volume workflow. Takio authorizes a
destination by canonical path below the configured volume root, writes through a
private partial file, verifies the completed copy, and records delivery metadata
under `.takio`. Removal is restricted to recorded deliveries and refuses changed
content. Eject is delegated to the operating system.

Rooted Kindle SSH/SCP delivery is available only through an explicit command with
strict host-key checking, key-file authentication, validated remote paths,
bounded execution, partial upload, remote size/hash verification, and atomic
publication. MTP and Amazon Send-to-Kindle remain unavailable.

## Explicit product gaps

Capability output advertises no reserved unsupported CLI commands. Native
EPUB-to-KEPUB conversion remains unavailable in the Rust executable. Other
product gaps include typed or multi-valued custom columns, custom sorting and
facets, arbitrary save-to-disk expressions, richer device transports, and
built-in reading/editing.

Metadata extraction/fetching, polishing, filename candidates, saved views,
attachment reconciliation, backup restore, the loopback content server, and
rooted Kindle SSH are native Rust modules. No command silently delegates to the
deleted Bun CLI.

## Security and release rules

- Treat paths, filenames, metadata, and automation requests as untrusted.
- Spawn tools with argument arrays, never interpolated shell commands.
- Bound structured inputs, process output, converter duration, and batch sizes.
- Refuse unintended overwrites.
- Verify bytes and SHA-256 at ownership and transfer boundaries.
- Keep caller-owned references outside deletion paths.
- Restore terminal state even after rendering or input failures.
- Package the native `takio-desktop` app and standalone `takio` CLI separately,
  both built from the same validated shared engine. Native distribution signing
  and notarization are separate from local ad-hoc signature verification.
