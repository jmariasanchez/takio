# Takio

**Takio** is a simple, local-first native ebook library manager: add the books
you already have, organize and find them, then send a compatible copy to your
Kindle. It is not a project to recreate all of Calibre.

The current product direction is
`docs/plans/2026-10-22-focused-native-library.md`. It supersedes the older
Calibre-parity expansion roadmaps. The native desktop is the primary experience;
the CLI and TUI retain advanced workflows and automation. Calibre is an optional
external conversion backend, not required for ordinary library management.

USB mass-storage delivery is the native hardware path. MTP and integrated Amazon
Send to Kindle are not supported. Rooted Kindle SSH/SCP remains an explicitly
opted-in CLI feature. Reader/editor, plugin, news, and remote-server expansion
are outside the focused first-version scope.

Takio is MIT licensed. Native transformation code is implemented independently
from public format specifications, interoperability tests, and observed file
behavior. Calibre is used only through its public command-line interface; GPL
source code is not copied, translated, or incorporated into Takio.

It is a hybrid Rust and Bun workspace with three deliberate product surfaces:

- **Desktop (`takio-desktop`)**: a native GPUI application linking the library engine directly. The earlier Electron app remains in `apps/desktop` behind `bun run electron:*` scripts for advanced legacy workflows, not as a feature-parity checklist. Measurements are recorded in `docs/specs/gpui-desktop.md`.
- **Terminal UI (`takio`)**: a keyboard-first Ratatui application for people who prefer to work without a desktop app.
- **CLI (`takio`)**: the same Rust binary, with deterministic JSON commands for AI agents, skills, automations, and power users.

The Rust CLI, TUI, and native desktop share one library store, conversion runner, job queue, and destination implementation. The desktop links the engine in-process; there is no sidecar, IPC, or JSON on the hot path. See `docs/specs/gpui-desktop.md`.

## Current milestone

The native desktop supports file/folder import and drag and drop, search and
facets, a responsive book list, covers and format inspection, basic book-details
editing, recoverable Trash, confirmed permanent deletion, and explicit verified
multi-book delivery to supported mounted readers. The default import keeps
originals. Searches cannot cancel operation results, and active operations or
unsaved details block normal app closure.

The shared engine also supports rich metadata and bulk export. Advanced metadata
candidate review, custom-column editing, and conversion tools remain in the CLI,
TUI, or legacy Electron desktop. They are not all exposed in the native UI.

Conversion currently supports EPUB-to-PDF, EPUB-to-AZW3, and DOCX, HTML, or
TXT to EPUB through a discovered Calibre `ebook-convert` backend. Conversion can
run immediately or through a durable local queue, but always runs in the
foreground. Each stored format is recorded as either a Takio-managed copy or a
reference to a caller-owned file.

### Everyday native workflow

1. Choose **Add books** (Cmd-Shift-I) or drop files/folders onto the window.
2. Search, filter, and select a book. **Edit Book Details** (Cmd-E) edits its
   title, authors, series, and tags. Separate multiple authors/tags with `;`.
   Save with Cmd-S or cancel with Escape. Edits change catalogue metadata, not
   the original ebook's embedded metadata.
3. Connect a mounted USB reader and choose **Refresh**. Use its explicit
   **Send selected** button, or **Reader > Send Selected Books** (Cmd-Shift-S).
   Takio chooses an attached compatible format and reports each result. Stock
   Kindle EPUB-only books are not copied as if they were readable.
4. If necessary, reveal an EPUB in the inspector and use **Open Send to Kindle
   website** for a manual Amazon upload. This opens the browser only: Takio does
   not access your Amazon account, upload files, or verify Amazon delivery.
5. Eject the reader after copying finishes. Use Trash for reversible removal and
   restore from the Trash section. Permanent deletion asks for confirmation.

Native delivery does not automatically convert books and does not support MTP.
No connected device is required to manage your library. On reader filesystems
without hard links, no-overwrite delivery uses an exclusive copy; a crash during
that fallback can leave an untracked partial destination file. It is never
reported as a successful delivery and is not overwritten automatically on retry.

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
| Primary role | Simple local-first native library and reader workflow | Full ebook suite with library UI, reader, editor, conversion, and plugins |
| File ownership | Explicit managed copies or caller-owned references | Normally imports books into a Calibre-managed library copy |
| Organization | Can keep originals, safely move them into Takio, or retain external references | Organizes imported copies inside Calibre's library structure |
| Automation | Stable JSON CLI for agents and scripts; native desktop links the engine directly | Broad command-line toolkit primarily serving the Calibre ecosystem |
| Interoperability | Imports Calibre metadata read-only and can use public Calibre tools as optional backends | Owns and operates its native library directly |

Takio does not replace Calibre's reader, editor, conversion engine, or plugin
ecosystem. It offers a narrower ownership-aware library workflow and can use
Calibre as an optional conversion and metadata backend.

## Requirements

- [Rust](https://www.rust-lang.org/tools/install) 1.97.1 for the CLI, TUI, and native desktop
- [Bun](https://bun.sh/) 1.3+ for the Electron/React workspace
- Xcode and its Metal toolchain on macOS for the native desktop build
- Optional [Calibre](https://calibre-ebook.com/download_osx) 9.9.0 or newer for the five currently advertised conversion pairs

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

# Native desktop app (macOS; needs the Xcode Metal toolchain:
# xcodebuild -downloadComponent MetalToolchain)
bun run desktop

# Enforce the desktop startup budgets on a generated 10k library
bun run desktop:bench

# Produce a signed dist/Takio.app
bun run desktop:package
```

To produce a checksummed standalone executable for the current macOS or Linux
platform, run `bun run release:cli`; outputs are written to `dist/releases` and
do not require Bun at runtime. A pushed `v<package-version>` tag publishes the
macOS and Linux artifacts through the release workflow. Calibre remains an
external runtime dependency for the advertised conversions.

## Library storage and schema v12

Importing with the default `copy` mode or attaching a format as a copy leaves
the selected source in place and creates a Takio-managed copy. Importing with `--mode move`
organizes the source into Takio: it publishes and verifies the managed copy
before removing the original. Attaching a reference records the external file
without copying it. Removing a format or item deletes only Takio-managed copies;
referenced files remain caller-owned and are never deleted.

The Rust store creates schema-v12 libraries and explicitly migrates supported
schema-v1 through schema-v11 libraries. It creates a verified, no-overwrite
pre-migration backup, applies adjacent migrations under one locked transaction,
and proves rollback before reporting a failed migration. Foreign schemas and
future versions are rejected rather than guessed at.

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
order, exact bytes, covers, per-format timestamps, and library-defined text
column definitions in native Rust. Portable v2 carries definitions while rebuild
continues to accept v1 sources.

## CLI for skills and agents

The Rust CLI preserves the one-line protocol while adding a human interface. Run
`takio` or `takio tui` in a terminal to open the library workspace. It includes
Library, Jobs, Devices, and Help sections, incremental search, an import prompt,
a command palette, safe trash confirmation, responsive small-terminal handling,
selected-book metadata candidate review with explicit field selection and online
opt-in, separate candidate-cover selection, and complete terminal restoration on
exit.

The CLI remains deterministic. Machine-readable successes use a one-line
`{"ok":true,"value":...}` envelope, and every failure uses
`{"ok":false,"error":{"code":"..."}}` with a nonzero exit status. Discovery
commands retain readable tables unless `--json` is requested.

Structured `--request-json` and `--patch-json` values can be passed inline, as
`-` to read stdin, or as `@path` to read a file. Inputs are capped at 16 KiB.
For example, `takio library export-many --request-json
'{"ids":["book-id"],"destinationPath":"/tmp/export","fileNameTemplate":"author-title","directoryTemplate":"author"}'`
uses `Author - title` names inside a sanitized author folder. The bounded
`directoryTemplate` presets are `flat` (the default), `author`, and `series`;
missing values use `Unknown author` or `Unsorted`. Every attached format is
accounted for separately and receives a stable SHA-256 item-identity suffix, so
same-title books do not collide and existing destination files are never
overwritten. Arbitrary user-authored path templates are intentionally not
accepted.

Library queries default to literal substring search. Set `querySyntax` to
`structured-v1` to use a bounded Calibre-style subset such as
`author:"Ursula K. Le Guin" tag:Classic not publisher:Tor`, or
`#shelf:"Favorites"` for a bounded user custom text field. Structured search
supports quoted values, implicit or explicit `and`, fixed metadata selectors,
and safe lowercase `#key` selectors. Literal search also includes user custom
field keys and values. The reserved candidate-audit field is excluded from
search, catalogues, portable interchange, and ordinary metadata updates.
Structured search intentionally does not yet support `or`, parentheses,
regular expressions, numeric/date comparisons, library-defined column labels,
typed custom values, custom sorting, or custom facets.

The legacy Electron metadata editor can keep, replace, or clear up to 64 bounded custom
text fields per book, and the inspector shows them as sorted `#key` entries.
Libraries can define up to 64 labeled, single-valued text columns. Definitions
survive migration, Calibre import, portable export/rebuild, and reopen; that desktop
uses their labels and can show one session-selected, non-sortable custom column in
the table. Typed or multi-valued columns, custom sorting and facets, persistent
column preferences, and bulk delta editing remain intentionally unsupported.
The Rust migration currently exposes the core daily-driver and automation surface:

| Command family | Purpose |
| --- | --- |
| `takio`, `takio tui` | Open the interactive terminal library with search, details, import, metadata review, trash, jobs, devices, and keyboard help. |
| `takio doctor`, `capabilities` | Report Rust implementation details, schema versions, limits, and live Calibre availability. |
| `takio formats`, `devices`, `plan`, `convert` | Inspect formats and execution targets, plan work, or run an advertised Calibre conversion synchronously. |
| `takio library path`, `verify`, `backup`, `restore-backup`, `portable-export`, `rebuild` | Locate, audit, snapshot, portably export, and safely restore a schema-v12 library and its managed files. |
| `takio library import`, `import-many`, `list`, `get`, `search`, `query`, `update`, `update-many`, `remove`, `export-many` | Import, browse, filter, edit, remove, and export the local catalogue. |
| `takio library catalog`, `content-search`, `validate`, `virtual-libraries` (`saved-views` alias) | Publish JSON, CSV, or HTML catalogues, inspect book contents, validate attached formats, and persist named virtual-library scopes. |
| `takio library format import`, `attach`, `remove`, `replace` | Manage owned copies and caller-owned format references, including guarded atomic replacement. |
| `takio library cover set`, `remove` | Manage Takio-owned cover images. |
| `takio library custom-columns list`, `create`, `rename`, `remove` | Manage bounded library-defined text-column labels while preserving per-book values on definition removal. |
| `takio library trash list`, `move`, `restore`, `purge` | Remove items recoverably or purge them permanently. |
| `takio library import-calibre`, `import-watch`; `takio metadata extract`, `fetch`, `candidates`; `takio polish` | Import or watch libraries, use bounded Calibre metadata and polishing tools, and explicitly review local or online metadata candidates. Candidate covers use opaque, expiring descriptors and require a separate apply choice. `metadata candidates reconcile` performs ordered, cancellable, read-only discovery for up to 64 books with at most four workers. |
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
reconciliation, virtual libraries, backup restore, portable rebuild,
Calibre-library import, watched import, duplicate review, loopback content
serving, and rooted Kindle SSH are implemented natively. Typed or multi-valued
custom columns, custom sorting and facets, arbitrary save-to-disk expressions,
richer device transports, and built-in reading/editing remain product gaps.

Mounted-volume delivery uses a private partial file, verifies bytes and SHA-256,
then records the delivery in `.takio/deliveries.json`. Removal verifies the file
again and refuses to delete changed content. Viewing remains delegated to the
operating system's installed applications.

## Workspace

```text
apps/desktop                Electron + React local-first desktop UI
apps/desktop-native         GPUI desktop linking the Rust engine in-process (see docs/specs/gpui-desktop.md)
apps/cli                    Rust CLI, Ratatui interface, SQLite store, jobs, and delivery
packages/core               Shared TypeScript domain used by the desktop renderer
packages/library-contract   Runtime-neutral desktop wire schemas
packages/library-store-bun  TypeScript reference and contract implementation for tests and migration work
packages/epub-transform     Independent TypeScript EPUB transformation library, not a Rust CLI backend
scripts/                    Release packaging, bundle verification, and performance gates
docs/                       Architecture and implementation records
```

## Quality commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run check
bun run test
bun run build
```

Read [the architecture](docs/architecture.md) for the system design and the
[focused native plan](docs/plans/2026-10-22-focused-native-library.md) for current
priorities. `AGENTS.md` describes the bounded autonomous development loop.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, quality gates, and contribution
policies. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
