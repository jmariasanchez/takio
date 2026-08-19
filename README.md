# Takio

**Takio** is a local-first ebook library and agent-native control plane. It
provides a predictable interface for managing, converting, and sending books
while using Calibre's proven command-line tools for conversion.

Takio is intended to replace operating Calibre directly for focused library
workflows, not to reimplement Calibre's reader, editor, conversion engine, or
plugin ecosystem. USB mass-storage delivery remains the default hardware path.
Rooted Kindle SSH/SCP delivery is available only through an explicit per-command
opt-in with host/user/key/path validation and no password handling. MTP and
Amazon Send-to-Kindle are reported as unavailable gated transports rather than
claimed as supported. Its optional content server is a narrow read-only delivery
surface rather than a browser reader.

Takio is MIT licensed. Native transformation code is implemented independently
from public format specifications, interoperability tests, and observed file
behavior. Calibre is used only through its public command-line interface; GPL
source code is not copied, translated, or incorporated into Takio.

It is a Bun monorepo with two deliberate product surfaces:

- **Desktop (`@takio/desktop`)** — a secure Electron application for people who want a calm, local-first library and conversion workspace.
- **CLI (`@takio/cli`)** — a structured, scriptable interface intended for AI agents, skills, automations, and power users.

The domain package (`@takio/core`) is shared by both surfaces, so a conversion request means the same thing whether it originates in the desktop app, a shell, or an agent skill.

## Current milestone

The workspace currently includes an Electron/React desktop app and a
durable local library with multi-format books, rich metadata, recursive import,
search and facets, saved views, duplicate review, covers, trash/restore, and
bulk export with title or author-title filename presets. The CLI can also transfer books to mounted macOS volumes and eject
them after a verified copy. Export and send materialize the current catalogue
metadata and owned cover into supported delivery formats without changing the
stored or caller-owned source.

Conversion currently supports EPUB-to-KEPUB through Takio's native MIT-licensed
transformer. EPUB-to-PDF, EPUB-to-AZW3, and DOCX, HTML, or TXT to EPUB use a
discovered Calibre `ebook-convert` backend. Conversion can run
immediately or through a durable local queue, but always runs in the foreground.
Each stored format is recorded as either a Takio-managed copy or a reference to
a caller-owned file.

## Requirements

- [Bun](https://bun.sh/) 1.3+ for development and source execution
- Xcode Command Line Tools on macOS for Electron packaging and sidecar verification
- [Calibre](https://calibre-ebook.com/download_osx) 9.9.0 or newer (optional for native EPUB-to-KEPUB; required for embedded and online metadata, delivery materialization, and the remaining ebook conversions)

## Quick start

```bash
bun install
bun run build
bun run test

# Agent-friendly CLI commands
bun run takio doctor
bun run takio capabilities
bun run takio formats --json
bun run takio library import --source-path ~/Books/example.epub
bun run takio library verify
bun run takio library backup --dest ~/Backups/takio-library
bun run takio library portable-export --dest ~/Exports/takio-portable
bun run takio library search --query "Ursula Le Guin"
bun run takio library list --human --dest /Volumes/Kindle
bun run takio library content-search --query "the dispossessed"
bun run takio library validate
bun run takio library catalog --format html --output ~/Exports/takio-catalog.html
bun run takio plan --input ~/Books/example.epub --to pdf --json
bun run takio polish --input ~/Books/example.epub --output ~/Books/example-polished.epub --operation remove-unused-css
bun run takio send --id <book-id> --format azw3 --convert --dest /Volumes/Kindle
# Explicit opt-in only. Do not run without your own rooted Kindle host/config.
bun run takio destination rooted-kindle-send --source ~/Books/example.epub --id <book-id> --host kindle.local --user root --remote-root /mnt/us/documents/koreader --identity-file ~/.ssh/kindle_key
bun run takio serve

# Native desktop app
bun run desktop

# Package an unpacked desktop app for smoke testing
bun run --filter '@takio/desktop' package:dir
```

To produce a checksummed standalone executable for the current macOS or Linux
platform, run `bun run release:cli`; outputs are written to `dist/releases` and
do not require Bun at runtime. A pushed `v<package-version>` tag publishes the
macOS and Linux artifacts through the release workflow. Calibre remains an
external runtime dependency for metadata extraction, polishing, and conversion.

## Library storage and schema v9

Importing with the default `copy` mode or attaching a format as a copy leaves
the selected source in place and creates a Takio-managed copy. Importing with `--mode move`
organizes the source into Takio: it publishes and verifies the managed copy
before removing the original. If original-file cleanup fails, Takio records the
obligation and retries it when the library is next opened. Attaching a reference records
the external file without copying it. Removing a format or item deletes only
Takio-managed copies; referenced files remain caller-owned and are never
deleted. If immediate managed-file cleanup fails, Takio records the obligation
and retries it when the library is next opened.

The first time the current storage implementation opens a schema-v1 through
schema-v8 library, it migrates the database atomically to schema v9 after
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

`takio library portable-export --dest <new-directory>` instead exports every
active book as OPF plus self-contained format and cover files, including
caller-owned references. `takio library rebuild --source <export> --db
<new-directory>/library.sqlite` verifies every manifest hash and reconstructs
all exported artifacts as managed copies. Rebuild refuses an existing target;
trash, saved views, duplicate-review state, and the job ledger remain backup-only
or operational state rather than portable book data.

## CLI for skills and agents

The CLI is deterministic. Machine-readable successes use a one-line
`{"ok":true,"value":...}` envelope, and every failure uses
`{"ok":false,"error":{"code":"..."}}` with a nonzero exit status. Discovery
commands retain readable tables unless `--json` is requested.

Structured `--request-json` and `--patch-json` values can be passed inline, as
`-` to read stdin, or as `@path` to read a file. Inputs are capped at 16 KiB.
For example, `takio library export-many --request-json
'{"ids":["book-id"],"destinationPath":"/tmp/export","fileNameTemplate":"author-title"}'`
uses `Author - title` names. Omitting `fileNameTemplate` or setting it to
`title` preserves the default title-only naming.
The command surface is grouped by workflow:

| Command family | Purpose |
| --- | --- |
| `takio doctor` | Report Calibre conversion-kernel health, resolved executable paths, comparison with the verified version baseline, and precise remediation for missing required tools. |
| `takio capabilities` | Return the protocol version, limits, schemas, formats, conversion pairs, and current backend availability in one JSON object. |
| `takio formats`, `devices`, `plan` | Inspect known formats and execution targets, or validate a conversion request. |
| `takio metadata extract` | Read normalized embedded metadata and cover facts without mutating the source or library. |
| `takio metadata fetch` | Fetch a reviewable online metadata candidate and optionally publish a cover to a new file. |
| `takio metadata candidates filename`, `item`, `apply` | Parse filename candidates, collect candidates for one existing item, then explicitly apply a selected candidate or patch with provenance. |
| `takio library verify` | Audit database structure and every managed format fingerprint without creating, migrating, or repairing the library. |
| `takio library backup`, `restore-backup` | Create and restore verified, non-overwriting snapshots of the catalogue and Takio-owned files. |
| `takio library portable-export`, `rebuild` | Export active books as verified OPF directories and reconstruct them into a new self-contained library. |
| `takio library import`, `import-many`, `import-calibre`, `import-watch` | Copy or explicitly move imports into Takio, recursively import roots, import a read-only Calibre library rooted at `metadata.db`, or rescan roots in a bounded/stoppable foreground loop. |
| `takio library list`, `get`, `open`, `search`, `query` | Read the catalogue through simple or structured queries. |
| `takio library catalog` | Publish a non-overwriting JSON, CSV, or HTML catalog without local source paths. |
| `takio library content-search` | Search literal text by extracting bounded temporary TXT through Calibre; no persistent index is created. |
| `takio library validate` | Check Calibre metadata parsing and bounded text extraction for selected formats; this is not EPUBCheck conformance. |
| `takio library update`, `update-many` | Update metadata for one item or apply one patch to up to 256 distinct items. |
| `takio library format import`, `attach`, `replace`, `remove` | Manage owned copies and caller-owned format references. |
| `takio library duplicates list`, `keep`, `reopen`, `merge` | Review and resolve duplicate candidates. |
| `takio library saved-views list`, `save`, `remove` | Persist reusable catalogue queries, facets, and sorts. |
| `takio library cover set`, `remove` | Manage owned cover images. |
| `takio library trash list`, `move`, `restore`, `purge` | Remove items recoverably or purge them permanently. |
| `takio library export-many` | Export selected formats without overwriting existing files, with optional `title` or `author-title` filename presets and current metadata when supported. |
| `takio convert` | Run any advertised conversion pair synchronously. |
| `takio polish` | Publish a new same-format EPUB, KEPUB, or AZW3 artifact with explicitly selected Calibre `ebook-polish` operations. |
| `takio jobs enqueue`, `list`, `get`, `cancel`, `retry`, `retry-attachment`, `run-next`, `drain` | Manage and boundedly drain the durable foreground conversion queue. |
| `takio destination list`, `eject`, `rooted-kindle-send` | Discover and safely eject mounted macOS volumes; optionally upload one caller-supplied file to a rooted Kindle over SSH/SCP when explicit host configuration is provided. |
| `takio send`, `send-many` | Materialize, copy, and verify one format; `send --convert` can select a tested device format, while batch delivery sends an attached exact format for up to 256 distinct items. |
| `takio serve` | Run a foreground authenticated, read-only catalog and format-download API. |

Use `takio --library <name> ...` to keep independent named libraries under the
Takio data directory. `--db <path>` remains available for an explicit physical
library path; combining both selectors is rejected.

`takio library list --human` emits a tabular view; add `--dest /Volumes/Kindle`
to include verified `present`, `changed`, `missing`, or `not-tracked` device
status. The default remains the stable one-line JSON envelope for scripts.

A plan is not execution. `takio convert` bypasses the queue, while `takio jobs enqueue` records work in `jobs.sqlite`, a database separate from `library.sqlite`. Jobs move through `queued`, `running`, `completed`, `failed`, and `canceled`; `jobs cancel` cancels queued work. `jobs retry` clones failed or canceled work into a new queued job while preserving the terminal record. `jobs retry-attachment --id <job>` returns a failed library attachment to `pending` without rerunning a completed conversion; it uses the selected default or named library and rejects an unrelated explicit jobs database. `run-next` claims one oldest job; `drain` runs up to 256 jobs by default, accepts a smaller `--max-jobs`, and reports processed, terminal, and remaining counts. Both run synchronously and record either a failure or a completed artifact whose path, nonzero size, and SHA-256 digest have been verified. SIGINT or SIGTERM cancels the active foreground conversion, records `conversion-cancelled`, and makes `drain` stop before claiming another job.

The caller chooses and owns the output path. Takio refuses to overwrite an existing file, including one that appears after enqueue. In the desktop app, an EPUB item's **Convert** control opens the native save dialog and adds the job to the conversion ledger. The desktop drains queued jobs serially while it is open, offers **Retry** for failed, canceled, or interrupted work, and retains **Refresh**, **Run next**, and queued-job **Cancel** as manual controls.

`metadata fetch` delegates network lookup to Calibre's
`fetch-ebook-metadata`. It never changes the library: review the returned
`value.metadata`, apply it with `library update --patch-json`, then use
`library cover set` if a requested `--cover-output` was returned. Cover output
is exclusive and never overwrites an existing path.

`metadata candidates filename --source-path <path>` emits schema version 1
candidate objects from bounded built-in patterns plus any repeated `--pattern`
regular expressions with named groups such as `title`, `author`, `series`, and
`seriesIndex`. `metadata candidates item --id <id> [--include-online]` opens an
existing library item, combines filename and embedded candidates, and optionally
adds a Calibre online lookup. Both commands are review-only. To mutate the
library, call `metadata candidates apply --id <id>` with exactly one of
`--candidate-json` or `--patch-json` and a non-empty `--provenance` note. Takio
then applies only that explicit patch through the normal library update API and
returns the applied source/provenance in the JSON envelope.

`library import-watch` is foreground-only, rescans the same validated roots,
and reuses the normal import and best-effort metadata-enrichment path. Stop it
with SIGINT/SIGTERM or use `--max-cycles`; it emits one aggregate JSON result.

This focused version intentionally has no daemon or detached worker, live
backend percentage stream, automatic retry, priorities, remote conversion
worker, or conversion pairs beyond the six advertised by `takio capabilities`.
`send --convert` prefers an attached device-compatible format, otherwise creates
the first tested target for a recognized Kobo or Kindle. `--format` overrides
that choice. Conversions use the corresponding Calibre output profile and KEPUB
delivery uses Kobo's `.kepub.epub` filename. A later send reuses an attached
format without requiring the conversion backend. Physical Kobo and Kindle
open/remount acceptance is still required before claiming hardware support.
Physical Kobo and Kindle USB mass-storage delivery remains unchanged: Takio
copies to the mounted filesystem through a private partial file, verifies bytes
and SHA-256, and refuses collisions unless an explicit overwrite option is used.
`destination rooted-kindle-send` is separate from USB send. It requires explicit
`--host`, `--user`, `--remote-root`, and optional absolute `--identity-file`, uses
system `ssh` and `scp` as argv arrays with `BatchMode=yes`, password auth disabled,
strict host-key checking by default, bounded per-command timeouts, private remote
partial names, remote size or SHA-256 verification, and non-overwrite publication.
The remote root must be an absolute `/mnt/us/...` KOReader or documents path.
Takio does not discover or contact rooted Kindles unless this command is invoked
with caller-supplied connection details. `takio capabilities` advertises this as
available but gated and reports MTP and Amazon Send-to-Kindle as unavailable gated
transports.

For KEPUB, EPUB, PDF, MOBI, AZW3, and DOCX delivery copies, a discovered `ebook-meta`
backend writes the current title, authors, structured metadata, identifiers,
tags, and owned cover before the copy is reported complete. Sources are never
rewritten. Each export/send result reports metadata as `embedded`, `unsupported`,
or `backend-unavailable`; a Calibre write failure removes the delivery copy and
returns a stable failure instead of reporting stale bytes.
Viewing and editing remain delegated to installed applications. The discovered
Calibre executables are trusted local configuration and run without a hostile-input
sandbox.

`takio serve` runs only until its foreground process exits. It prints one
startup JSON object containing a fresh 256-bit bearer token and URL, requires
that token on every `/v1` request, and exposes only health, bounded catalog/item
metadata, and attached-format download routes. It binds to `127.0.0.1` by
default. A non-loopback host requires `--allow-remote` plus both `--tls-cert`
and `--tls-key`; request URLs never contain filesystem paths, and responses
never disclose them. There is no static root, mutation API, persisted token,
daemon, or browser reader.

## Workspace

```text
apps/desktop       Electron + React local-first desktop UI
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
