# Takio

**Takio** is a local-first ebook library and agent-native control plane. It
provides a predictable interface for managing, converting, and sending books
while using Calibre's proven command-line tools for conversion.

Takio is intended to replace operating Calibre directly for focused library
workflows, not to reimplement Calibre's reader, editor, server, or plugin
ecosystem.

It is a Bun monorepo with two deliberate product surfaces:

- **Desktop (`@takio/desktop`)** — a native Tauri application for people who want a calm, local-first library and conversion workspace.
- **CLI (`@takio/cli`)** — a structured, scriptable interface intended for AI agents, skills, automations, and power users.

The domain package (`@takio/core`) is shared by both surfaces, so a conversion request means the same thing whether it originates in the desktop app, a shell, or an agent skill.

## Current milestone

The workspace currently includes a polished Tauri/React desktop app and a
durable local library with multi-format books, rich metadata, recursive import,
search and facets, saved views, duplicate review, covers, trash/restore, and
bulk export. The CLI can also transfer books to mounted macOS volumes and eject
them after a verified copy. Export and send materialize the current catalogue
metadata and owned cover into supported delivery formats without changing the
stored or caller-owned source.

Conversion currently supports EPUB-to-PDF, EPUB-to-AZW3, and DOCX, HTML, or TXT
to EPUB through a discovered Calibre `ebook-convert` backend. It can run
immediately or through a durable local queue, but always runs in the foreground.
Each stored format is recorded as either a Takio-managed copy or a reference to
a caller-owned file.

## Requirements

- [Bun](https://bun.sh/) 1.3+ for development and source execution
- Rust/Cargo plus Xcode Command Line Tools for Tauri desktop builds
- [Calibre](https://calibre-ebook.com/download_osx) for embedded and online metadata, delivery materialization, and ebook conversion

## Quick start

```bash
bun install
bun run build
bun run test

# Agent-friendly CLI commands
bun run takio capabilities
bun run takio formats --json
bun run takio library import --source-path ~/Books/example.epub
bun run takio library verify
bun run takio library backup --dest ~/Backups/takio-library
bun run takio library search --query "Ursula Le Guin"
bun run takio plan --input ~/Books/example.epub --to pdf --json
bun run takio send --id <book-id> --format azw3 --convert --dest /Volumes/Kindle

# Native desktop app
bun run desktop
```

To produce a standalone executable for the current platform, run
`bun run build:cli:binary`; the result is `apps/cli/dist/takio` and does not
require Bun at runtime. Calibre remains an external runtime dependency for
metadata extraction and conversion.

## Library storage and schema v8

Importing a library item or attaching a format as a copy leaves the selected
source in place and creates a Takio-managed copy. Attaching a reference records
the external file without copying it. Removing a format or item deletes only
Takio-managed copies; referenced files remain caller-owned and are never
deleted. If immediate managed-file cleanup fails, Takio records the obligation
and retries it when the library is next opened.

The first time the current storage implementation opens a schema-v1 through
schema-v7 library, it migrates the database atomically to schema v8 after
retaining a verified backup named `<database>.vN.backup`. Migrated formats from
schemas that predate ownership tracking are treated as references. There is no
in-place downgrade: older binaries reject a schema they do not understand, and
restoring a migration backup loses database changes made after that backup.

Migration backups contain database metadata only. Preserve and move
`library.sqlite` together with its sibling `items` and `covers` directories so
Takio-managed books and covers remain recoverable.

`takio library verify [--db <path>]` is a read-only audit. It does not create,
migrate, or repair a library. It checks the current schema, SQLite integrity,
foreign keys, stored catalogue data, duplicate-review records, and the byte
count and SHA-256 fingerprint of every managed format. A successful report
includes active/trashed item and managed/referenced format counts; a missing,
incompatible, or damaged library fails with a stable machine-readable code.

`takio library backup --dest <new-directory>` creates a SQLite-consistent,
verified snapshot containing `library.sqlite`, every Takio-managed format and
cover, and a machine-readable manifest. It never overwrites a destination.
`takio library restore-backup --source <backup> --db <new-path>` re-verifies the
snapshot and publishes it only into an absent library directory. Referenced
files and the independent `jobs.sqlite` conversion ledger are not copied.

## CLI for skills and agents

The CLI is deterministic. Machine-readable successes use a one-line
`{"ok":true,"value":...}` envelope, and every failure uses
`{"ok":false,"error":{"code":"..."}}` with a nonzero exit status. Discovery
commands retain readable tables unless `--json` is requested.

Structured `--request-json` and `--patch-json` values can be passed inline, as
`-` to read stdin, or as `@path` to read a file. Inputs are capped at 16 KiB.
The command surface is grouped by workflow:

| Command family | Purpose |
| --- | --- |
| `takio capabilities` | Return the protocol version, limits, schemas, formats, conversion pairs, and current backend availability in one JSON object. |
| `takio formats`, `devices`, `plan` | Inspect known formats and execution targets, or validate a conversion request. |
| `takio metadata extract` | Read normalized embedded metadata and cover facts without mutating the source or library. |
| `takio metadata fetch` | Fetch a reviewable online metadata candidate and optionally publish a cover to a new file. |
| `takio library verify` | Audit database structure and every managed format fingerprint without creating, migrating, or repairing the library. |
| `takio library backup`, `restore-backup` | Create and restore verified, non-overwriting snapshots of the catalogue and Takio-owned files. |
| `takio library import`, `import-many` | Import one file or recursively import files and directories. |
| `takio library list`, `get`, `open`, `search`, `query` | Read the catalogue through simple or structured queries. |
| `takio library update`, `update-many` | Update metadata for one item or apply one patch to up to 256 distinct items. |
| `takio library format import`, `attach`, `replace`, `remove` | Manage owned copies and caller-owned format references. |
| `takio library duplicates list`, `keep`, `reopen`, `merge` | Review and resolve duplicate candidates. |
| `takio library saved-views list`, `save`, `remove` | Persist reusable catalogue queries, facets, and sorts. |
| `takio library cover set`, `remove` | Manage owned cover images. |
| `takio library trash list`, `move`, `restore`, `purge` | Remove items recoverably or purge them permanently. |
| `takio library export-many` | Export selected formats without overwriting existing files, materializing current metadata when supported. |
| `takio convert` | Run any advertised conversion pair synchronously. |
| `takio jobs enqueue`, `list`, `get`, `cancel`, `retry`, `run-next`, `drain` | Manage and boundedly drain the durable foreground conversion queue. |
| `takio destination list`, `eject` | Discover and safely eject mounted macOS volumes. |
| `takio send`, `send-many` | Materialize, copy, and verify one format; batch delivery sends an attached exact format for up to 256 distinct items. |

Use `takio --library <name> ...` to keep independent named libraries under the
Takio data directory. `--db <path>` remains available for an explicit physical
library path; combining both selectors is rejected.

A plan is not execution. `takio convert` bypasses the queue, while `takio jobs enqueue` records work in `jobs.sqlite`, a database separate from `library.sqlite`. Jobs move through `queued`, `running`, `completed`, `failed`, and `canceled`; `jobs cancel` cancels queued work. `jobs retry` clones failed or canceled work into a new queued job while preserving the terminal record. `run-next` claims one oldest job; `drain` runs up to 256 jobs by default, accepts a smaller `--max-jobs`, and reports processed, terminal, and remaining counts. Both run synchronously and record either a failure or a completed artifact whose path, nonzero size, and SHA-256 digest have been verified. SIGINT or SIGTERM cancels the active foreground conversion, records `conversion-cancelled`, and makes `drain` stop before claiming another job.

The caller chooses and owns the output path. Takio refuses to overwrite an existing file, including one that appears after enqueue. In the desktop app, an EPUB item's **Convert** control opens the native save dialog and adds the job to the conversion ledger; **Refresh**, **Run next**, and queued-job **Cancel** expose the same durable queue.

`metadata fetch` delegates network lookup to Calibre's
`fetch-ebook-metadata`. It never changes the library: review the returned
`value.metadata`, apply it with `library update --patch-json`, then use
`library cover set` if a requested `--cover-output` was returned. Cover output
is exclusive and never overwrites an existing path.

This focused version intentionally has no daemon or detached worker, live
backend percentage stream, automatic retry, priorities, remote
execution, automatic device-format guessing, or conversion pairs beyond the
five advertised by `takio capabilities`. `send --format <format> --convert` is the
explicit convert-and-send path: it prefers an attached exact format, otherwise
uses the first compatible stored format, verifies the conversion, attaches a
managed copy, and then performs the verified destination copy. A later send
reuses that attached format without requiring the conversion backend.
For EPUB, PDF, MOBI, AZW3, and DOCX delivery copies, a discovered `ebook-meta`
backend writes the current title, authors, structured metadata, identifiers,
tags, and owned cover before the copy is reported complete. Sources are never
rewritten. Each export/send result reports metadata as `embedded`, `unsupported`,
or `backend-unavailable`; a Calibre write failure removes the delivery copy and
returns a stable failure instead of reporting stale bytes.
Viewing and editing remain delegated to installed applications. The discovered
Calibre executables are trusted local configuration and run without a hostile-input
sandbox.

## Workspace

```text
apps/desktop       Tauri v2 + React minimalist native UI
apps/cli           Bun-powered CLI for agents and scripts
packages/core      Shared formats, request validation, device planner
docs/              Architecture and implementation records
```

## Quality commands

```bash
bun run check
bun run test
bun run build
```

Read [the architecture](docs/architecture.md) for the system design and the
[Calibre-competitive roadmap](docs/roadmaps/calibre-competitive-product-roadmap.md)
for the deliberately scoped path ahead.
