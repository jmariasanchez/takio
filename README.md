# Takio

**Takio** is a lightweight, modern, minimalist alternative to Calibre.

It is a Bun monorepo with two deliberate product surfaces:

- **Desktop (`@takio/desktop`)** — a native Tauri application for people who want a calm, local-first library and conversion workspace.
- **CLI (`@takio/cli`)** — a structured, scriptable interface intended for AI agents, skills, automations, and power users.

The domain package (`@takio/core`) is shared by both surfaces, so a conversion request means the same thing whether it originates in the desktop app, a shell, or an agent skill.

## Current milestone

The workspace currently includes a polished Tauri/React desktop app, a durable
local library, a capability-aware CLI conversion planner, and verified
EPUB-to-PDF conversion through a discovered Calibre `ebook-convert` backend.
Library items can hold multiple formats, with each format recorded explicitly as
either a Takio-managed copy or a reference to a caller-owned file. Conversion
can run immediately or through a durable local queue, but always runs in the
foreground.

## Requirements

- [Bun](https://bun.sh/) 1.3+
- Rust/Cargo plus Xcode Command Line Tools for Tauri desktop builds

## Quick start

```bash
bun install
bun run build
bun run test

# Agent-friendly CLI commands
bun run takio formats --json
bun run takio devices
bun run takio plan --input ~/Books/example.epub --to pdf --json

# Native desktop app
bun run desktop
```

## Library storage and schema v4

Importing a library item or attaching a format as a copy leaves the selected
source in place and creates a Takio-managed copy. Attaching a reference records
the external file without copying it. Removing a format or item deletes only
Takio-managed copies; referenced files remain caller-owned and are never
deleted. If immediate managed-file cleanup fails, Takio records the obligation
and retries it when the library is next opened.

The first time the current storage implementation opens a schema-v1, v2, or v3
library, it migrates the database atomically to schema v4 after retaining a
verified backup named `<database>.v1.backup`, `<database>.v2.backup`, or
`<database>.v3.backup`. Migrated legacy formats are treated as references
because the older schemas did not record ownership. There is no in-place
downgrade: older binaries reject a v4 database, and restoring a pre-v4 backup
loses database changes made after that backup.

Migration backups contain database metadata only. Preserve and move
`library.sqlite` together with its sibling `items` and `covers` directories so
Takio-managed books and covers remain recoverable.

## CLI contract for skills and agents

The CLI is deliberately deterministic and supports JSON responses for consumption by tools:

| Command | Purpose |
| --- | --- |
| `takio formats --json` | Reads the built-in format catalogue. |
| `takio devices` | Lists known conversion devices. |
| `takio plan --input <path> --to <format> --json` | Validates a request and creates a machine-readable conversion plan. |
| `takio convert --input <epub> --to pdf --output <path>` | Executes one EPUB-to-PDF conversion synchronously and reports a verified artifact. |
| `takio jobs enqueue --input <epub> --to pdf --output <path>` | Adds a conversion to the durable local queue. |
| `takio jobs list [--status <status>]` | Lists all jobs or filters by status. |
| `takio jobs get --id <id>` | Reads one durable job record. |
| `takio jobs cancel --id <id>` | Cancels a queued job. |
| `takio jobs run-next` | Runs at most one queued job in the foreground. |

A plan is not execution. `takio convert` bypasses the queue, while `takio jobs enqueue` records work in `jobs.sqlite`, a database separate from `library.sqlite`. Jobs move through `queued`, `running`, `completed`, `failed`, and `canceled`; cancellation is queued-only. `run-next` claims the oldest queued job, runs it synchronously, and records either a failure or a completed artifact whose path, nonzero size, and SHA-256 digest have been verified.

The caller chooses and owns the output path. Takio refuses to overwrite an existing file, including one that appears after enqueue. In the desktop app, an EPUB item's **Convert** control opens the native save dialog and adds the job to the conversion ledger; **Refresh**, **Run next**, and queued-job **Cancel** expose the same durable queue.

This focused v1 intentionally has no daemon or detached worker, live progress stream, automatic retry, priorities, batching, active cancellation, overwrite mode for queued jobs, remote execution, or conversion pairs beyond EPUB-to-PDF. The discovered `ebook-convert` executable is trusted local configuration and runs without a hostile-input sandbox.

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

Read [the architecture](docs/architecture.md) for the execution, multi-device, and security roadmap.
