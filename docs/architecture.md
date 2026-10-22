# Takio Architecture

## Product surfaces

Takio has three user-facing surfaces backed by one native Rust executable:

1. **Electron desktop** for the full graphical library workflow.
2. **Ratatui terminal UI** for keyboard-first human use.
3. **JSON CLI** for agents, scripts, skills, and power users.

The Electron renderer remains a Bun and TypeScript workspace. It packages the
Rust `takio` binary as `takio-library-engine` and communicates with it through a
strict process boundary. The desktop never imports Rust internals and the Rust
binary never launches Bun as a fallback.

## Workspace boundaries

| Boundary | Responsibility |
| --- | --- |
| `apps/cli` | Rust CLI, Ratatui interface, SQLite library, conversion queue, Calibre adapters, content server, and verified delivery |
| `apps/desktop-native` | GPUI desktop that links `apps/cli` as a library: engine thread, state entity, virtualized views, native menus and dialogs |
| `apps/desktop` | Electron shell, context-isolated preload, React renderer, native dialogs, and Rust sidecar packaging |
| `packages/core` | Renderer-side ebook domain schemas and format vocabulary |
| `packages/library-contract` | Runtime-neutral desktop wire schemas |
| `packages/library-store-bun` | TypeScript reference and contract implementation retained for renderer tests and future migration work |
| `packages/epub-transform` | Independent TypeScript EPUB transformation library, not a Rust CLI conversion backend |
| `scripts/` | Release packaging, bundle verification, and performance gates |

## Rust executable

The `takio` crate is split by responsibility:

| Module | Responsibility |
| --- | --- |
| `cli` | Clap command tree, stable envelopes, desktop-compatible request mapping, and persistent service mode |
| `store` | Schema-v12 SQLite catalogue and owned-file transactions |
| `fingerprint` | Shared streaming SHA-256 byte-count and digest helpers used by every owned-file operation |
| `jobs` | Independent schema-v4 foreground conversion ledger |
| `conversion` | Format detection, Calibre discovery, planning, execution, and artifact verification |
| `destinations` | Mounted-volume authorization, verified copy, inventory, removal, and eject |
| `kindle_ssh` | Explicit rooted Kindle SSH/SCP validation, upload, remote verification, and publication |
| `metadata` | Bounded Calibre metadata extraction/fetching, OPF parsing, and cover publication |
| `maintenance` | Ebook polishing and bounded text extraction for content search and validation |
| `server` | Authenticated loopback-only read-only catalogue and format delivery |
| `tui` | Ratatui application state, keyboard handling, responsive rendering, and terminal restoration |
| `paths` | Default, named, and explicit library path resolution |
| `model` | Library item, author, format, provenance, and metadata patch wire models |

The crate forbids unsafe Rust. SQLite is bundled through `rusqlite`, so the
standalone executable does not depend on a system SQLite installation.

## Process protocol

Every machine command writes exactly one JSON record to stdout:

```json
{"ok":true,"value":{}}
```

Failures use a stable code and a nonzero exit status:

```json
{"ok":false,"error":{"code":"invalid-arguments"}}
```

Machine commands keep stderr empty. Structured request values are limited to 16
KiB and can be supplied inline, through stdin with `-`, or from a file with
`@path`.

The Electron bridge uses two execution modes:

- Read operations and independent commands spawn one short-lived sidecar.
- Mutating library operations reuse `takio library service`, a newline-delimited
  request loop that correlates every response with the caller's request ID.

The bridge caps output, validates the process exit code against the JSON
envelope, and rejects unexpected command names before spawning anything.

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
Native workflows also include Calibre-library import, watched import, duplicate
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
Calibre application path. Capabilities advertise conversion pairs only when the
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

- Treat paths, filenames, metadata, and sidecar messages as untrusted.
- Spawn tools with argument arrays, never interpolated shell commands.
- Bound structured inputs, process output, converter duration, and batch sizes.
- Refuse unintended overwrites.
- Verify bytes and SHA-256 at ownership and transfer boundaries.
- Keep caller-owned references outside deletion paths.
- Restore terminal state even after rendering or input failures.
- Package the same validated Rust executable as the standalone CLI and Electron
  sidecar.
