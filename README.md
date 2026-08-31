# Takio

**Takio** is a local-first ebook library and agent-native control plane. It
provides a predictable interface for managing, converting, and sending books
while using Calibre's proven command-line tools for conversion.

Takio is intended to replace operating Calibre directly for focused library
workflows. The current release does not yet reimplement Calibre's reader,
editor, or plugin ecosystem, but those product areas are now part of the
acceptance-gated roadmap in
`docs/roadmaps/calibre-gap-closure-2-9.md`. Takio does not plan to build a
general-purpose conversion engine. USB mass-storage delivery remains the
default hardware path. Rooted Kindle SSH/SCP delivery is available only through
an explicit per-command opt-in with host/user/key/path validation and no
password handling. MTP and Amazon Send-to-Kindle are reported as unavailable
gated transports rather than claimed as supported. The current optional content
server is a narrow read-only delivery surface; remote multi-user service and
browser reading are planned as later gated milestones.

Takio is MIT licensed. Native transformation code is implemented independently
from public format specifications, interoperability tests, and observed file
behavior. Calibre is used only through its public command-line interface; GPL
source code is not copied, translated, or incorporated into Takio.

It is a hybrid Rust and Bun workspace with three deliberate product surfaces:

- **Desktop (`@takio/desktop`)**: a secure Electron application for people who want a calm, local-first library and conversion workspace.
- **Terminal UI (`takio`)**: a keyboard-first Ratatui application for people who prefer to work without a desktop app.
- **CLI (`takio`)**: the same Rust binary, with deterministic JSON commands for AI agents, skills, automations, and power users.

The Rust CLI and TUI share one library store, conversion runner, job queue, and destination implementation. The Electron desktop packages that Rust binary as its library sidecar.

## Current milestone

The workspace currently includes an Electron/React desktop app and a
durable local library with multi-format books, rich metadata, recursive import,
search and facets, covers, trash/restore, and bulk export with title or
author-title filename presets. The CLI can also transfer books to mounted macOS
volumes and eject them after a verified copy. Export and send copy and verify the
selected stored format without changing the stored or caller-owned source.

Conversion currently supports EPUB-to-PDF, EPUB-to-AZW3, and DOCX, HTML, or
TXT to EPUB through a discovered Calibre `ebook-convert` backend. Conversion can
run immediately or through a durable local queue, but always runs in the
foreground. Each stored format is recorded as either a Takio-managed copy or a
reference to a caller-owned file.

## How library management works

Takio keeps one searchable SQLite catalogue for titles, authors, formats,
metadata, covers, saved views, trash, and duplicate-review state. Book bytes are
handled separately and every format has explicit ownership:

- **Keep originals (`copy`)** creates a verified Takio-managed copy and leaves
  the selected file where it is.
- **Organize into Takio (`move`)** creates and verifies the managed copy before
  removing the original.
- **Reference** stores the external path without copying the file. Takio can
  detach the reference, but never deletes the caller-owned file.

This makes the database the place to browse and search, while ownership rules
decide whether the actual book remains in its existing folder or is organized
under Takio.

### Takio compared with Calibre

| | Takio | Calibre |
| --- | --- | --- |
| Primary role | Local-first library workflow and automation control plane | Full ebook suite with library UI, reader, editor, conversion, and plugins |
| File ownership | Explicit managed copies or caller-owned references | Normally imports books into a Calibre-managed library copy |
| Organization | Can keep originals, safely move them into Takio, or retain external references | Organizes imported copies inside Calibre's library structure |
| Automation | Stable JSON CLI and desktop sidecar designed for agents and scripts | Broad command-line toolkit primarily serving the Calibre ecosystem |
| Interoperability | Imports Calibre metadata read-only and can use public Calibre tools as optional backends | Owns and operates its native library directly |

Takio does not replace Calibre's reader, editor, conversion engine, or plugin
ecosystem. It offers a narrower ownership-aware library workflow and can use
Calibre as an optional conversion and metadata backend.

## Requirements

- [Rust](https://www.rust-lang.org/tools/install) 1.97.1 for the CLI, TUI, and desktop sidecar
- [Bun](https://bun.sh/) 1.3+ for the Electron/React workspace
- Xcode Command Line Tools on macOS for Electron packaging and sidecar verification
- [Calibre](https://calibre-ebook.com/download_osx) 9.9.0 or newer for the five currently advertised conversion pairs

## Quick start

```bash
bun install
cargo build --release -p takio
cargo test -p takio

# Human-first terminal UI
cargo run -p takio
# or, after installing/copying the release binary
takio

# Agent-friendly CLI commands
cargo run -p takio -- doctor
cargo run -p takio -- capabilities
cargo run -p takio -- formats --json
cargo run -p takio -- library import --source-path ~/Books/example.epub
cargo run -p takio -- library verify
cargo run -p takio -- library backup --dest ~/Backups/takio-library
cargo run -p takio -- library search --query "Ursula Le Guin"
cargo run -p takio -- library list --human
cargo run -p takio -- plan --input ~/Books/example.epub --to pdf --json
cargo run -p takio -- jobs enqueue --input ~/Books/example.epub --to pdf --output ~/Books/example.pdf
cargo run -p takio -- destination list

# Native desktop app
bun run desktop

# Package an unpacked desktop app for smoke testing
bun run --filter '@takio/desktop' package:dir
```

To produce a checksummed standalone executable for the current macOS or Linux
platform, run `bun run release:cli`; outputs are written to `dist/releases` and
do not require Bun at runtime. A pushed `v<package-version>` tag publishes the
macOS and Linux artifacts through the release workflow. Calibre remains an
external runtime dependency for the advertised conversions.

## Library storage and schema v10

Importing with the default `copy` mode or attaching a format as a copy leaves
the selected source in place and creates a Takio-managed copy. Importing with `--mode move`
organizes the source into Takio: it publishes and verifies the managed copy
before removing the original. Attaching a reference records the external file
without copying it. Removing a format or item deletes only Takio-managed copies;
referenced files remain caller-owned and are never deleted.

The Rust store creates and opens schema-v10 libraries. It deliberately rejects
older or future nonzero schema versions instead of attempting a risky migration.
Upgrade an older library with the last compatible Takio release and retain its
verified migration backup before opening it with this Rust version.

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
`takio library restore-backup --source <backup> --db <new-path>` verifies and
rebases that snapshot into an absent library path without retaining paths to the
original library or disturbing unrelated files in an existing parent directory.
Portable OPF export and verified rebuild preserve item IDs, metadata, format
order, exact bytes, covers, and per-format timestamps in native Rust.

## CLI for skills and agents

The Rust CLI preserves the one-line protocol while adding a human interface. Run
`takio` or `takio tui` in a terminal to open the library workspace. It includes
Library, Jobs, Devices, and Help sections, incremental search, an import prompt,
a command palette, safe trash confirmation, responsive small-terminal handling,
selected-book metadata candidate review with explicit field selection and online
opt-in, and complete terminal restoration on exit.

The CLI remains deterministic. Machine-readable successes use a one-line
`{"ok":true,"value":...}` envelope, and every failure uses
`{"ok":false,"error":{"code":"..."}}` with a nonzero exit status. Discovery
commands retain readable tables unless `--json` is requested.

Structured `--request-json` and `--patch-json` values can be passed inline, as
`-` to read stdin, or as `@path` to read a file. Inputs are capped at 16 KiB.
For example, `takio library export-many --request-json
'{"ids":["book-id"],"destinationPath":"/tmp/export","fileNameTemplate":"author-title"}'`
uses `Author - title` names. Omitting `fileNameTemplate` or setting it to
`title` preserves the default title-only naming.
The Rust migration currently exposes the core daily-driver and automation surface:

| Command family | Purpose |
| --- | --- |
| `takio`, `takio tui` | Open the interactive terminal library with search, details, import, metadata review, trash, jobs, devices, and keyboard help. |
| `takio doctor`, `capabilities` | Report Rust implementation details, schema versions, limits, and live Calibre availability. |
| `takio formats`, `devices`, `plan`, `convert` | Inspect formats and execution targets, plan work, or run an advertised Calibre conversion synchronously. |
| `takio library path`, `verify`, `backup`, `restore-backup`, `portable-export`, `rebuild` | Locate, audit, snapshot, portably export, and safely restore a schema-v11 library and its managed files. |
| `takio library import`, `import-many`, `list`, `get`, `search`, `query`, `update`, `update-many`, `remove`, `export-many` | Import, browse, filter, edit, remove, and export the local catalogue. |
| `takio library catalog`, `content-search`, `validate`, `saved-views` | Publish JSON, CSV, or HTML catalogues, inspect book contents, validate attached formats, and persist reusable views. |
| `takio library format import`, `attach`, `remove`, `replace` | Manage owned copies and caller-owned format references, including guarded atomic replacement. |
| `takio library cover set`, `remove` | Manage Takio-owned cover images. |
| `takio library trash list`, `move`, `restore`, `purge` | Remove items recoverably or purge them permanently. |
| `takio library import-calibre`, `import-watch`; `takio metadata extract`, `fetch`, `candidates`; `takio polish` | Import or watch libraries, use bounded Calibre metadata and polishing tools, and explicitly review local or online metadata candidates. `metadata candidates reconcile` performs ordered, cancellable, read-only discovery for up to 64 books with at most four workers. |
| `takio jobs enqueue`, `list`, `get`, `cancel`, `retry`, `retry-attachment`, `run-next`, `drain` | Manage the schema-v4 durable foreground conversion queue and reconcile completed outputs with library items. |
| `takio destination list`, `inventory`, `reconcile`, `remove`, `eject`, `rooted-kindle-send` | Discover mounted volumes, manage verified delivery records, or explicitly opt into hardened SSH/SCP delivery. |
| `takio send` | Copy and SHA-256 verify an attached format on an authorized mounted destination. |
| `takio serve` | Run an authenticated, loopback-only, read-only HTTP catalogue and format server. |

The Rust capabilities report currently advertises no reserved unsupported CLI
commands. The standalone binary does not launch Bun or JavaScript as a fallback.

Use `takio --library <name> ...` to keep independent named libraries under the
Takio data directory. `--db <path>` remains available for an explicit physical
library path; combining both selectors is rejected.

`takio library list --human` emits a readable table. The default remains the
stable one-line JSON envelope for scripts.

A plan is not execution. `takio convert` bypasses the queue, while `takio jobs
enqueue` records work in `jobs.sqlite`, separate from `library.sqlite`. Jobs move
through `queued`, `running`, `completed`, `failed`, and `canceled`. `run-next`
claims one oldest job and `drain` processes a caller-bounded number of jobs in the
foreground. Conversion output is published only after the adapter exits
successfully and the artifact has a recorded byte count and SHA-256 digest.

The caller chooses and owns the output path. Takio refuses to overwrite an
existing file. The Rust CLI currently advertises the five Calibre-backed
pairs only: EPUB to PDF, EPUB to AZW3, and DOCX, HTML, or TXT to EPUB. Native
EPUB-to-KEPUB remains unavailable. Metadata automation, polishing, attachment
reconciliation, saved views, backup restore, loopback content serving, and rooted
Kindle SSH are implemented natively. Portable rebuild, Calibre-library import,
watched import, and duplicate review remain explicit migration gaps.

Mounted-volume delivery uses a private partial file, verifies bytes and SHA-256,
then records the delivery in `.takio/deliveries.json`. Removal verifies the file
again and refuses to delete changed content. Viewing remains delegated to the
operating system's installed applications.

## Workspace

```text
apps/desktop       Electron + React local-first desktop UI
apps/cli           Rust CLI, Ratatui interface, SQLite store, jobs, and delivery
packages/core      Shared TypeScript domain used by the desktop renderer
docs/              Architecture and implementation records
```

## Quality commands

```bash
cargo fmt --all --check
cargo clippy -p takio --all-targets -- -D warnings
cargo test -p takio
bun run check
bun run test
bun run build
```

Read [the architecture](docs/architecture.md) for the system design and the
[Calibre-competitive roadmap](docs/roadmaps/calibre-competitive-product-roadmap.md)
for the deliberately scoped path ahead.
