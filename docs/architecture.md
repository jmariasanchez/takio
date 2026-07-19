# Takio Architecture

## Product

Takio replaces the heavyweight, application-centric Calibre workflow with a focused local-first product:

1. A **minimal Tauri desktop UI** for browsing a small library, choosing a document, and following conversions.
2. A **Bun CLI** designed as a dependable interface for humans, AI agents, skills, and automations.
3. A **shared TypeScript domain package** so both interfaces produce identical, validated conversion jobs.

## Monorepo boundaries

| Package | Responsibility | Status |
| --- | --- | --- |
| `@takio/core` | Format catalogue, detection, request validation, device-aware planning | Implemented |
| `@takio/cli` | Structured commands for tools and agents | Implemented: planning, synchronous EPUB-to-PDF conversion, and durable foreground jobs |
| `@takio/desktop` | Tauri v2 native shell and minimalist React interface | Implemented: library, destinations, and conversion queue |
| Converter adapters | Declare supported pairs and invoke a real engine safely | Implemented: local `ebook-convert`, synchronous EPUB-to-PDF |
| Controller/queue | Persist local jobs and run one foreground job at a time | Implemented: separate `jobs.sqlite` queue |
| Destination transfer | Detect mounted USB mass-storage recipients and copy verified library files | Implemented: macOS |
| Device agent | Authenticated worker that advertises adapters and capacity | Planned |

A `Destination` is a passive mounted recipient volume, distinct from the planned device agent that will act as an authenticated remote execution worker.

Local `ebook-convert` discovery checks `TAKIO_EBOOK_CONVERT`, then `PATH`, then `/Applications/calibre.app/Contents/MacOS/ebook-convert` on macOS.

`ebook-convert` is trusted local configuration, not a sandbox; hostile-input resource isolation is not provided.

The conversion queue uses `jobs.sqlite` beside, but independent from, `library.sqlite`. Its CLI is deliberately exact: `jobs enqueue`, `jobs list`, `jobs get`, queued-only `jobs cancel`, and one-shot `jobs run-next`. The state machine is `queued` → `running` → `completed` or `failed`, plus `queued` → `canceled`. `run-next` claims the oldest queued job and runs it in the caller's foreground process; no daemon claims work in the background.

The caller owns the requested output path, and enqueue refuses a path that already exists. Execution also refuses to overwrite a file that appeared later. A job becomes `completed` only after the output path, nonzero size, and SHA-256 digest are verified and recorded.

The desktop exposes the same contract: **Convert** on an EPUB item opens a native save dialog and adds a ledger entry, while **Refresh**, **Run next**, and queued-job **Cancel** list and operate the durable jobs.

## Agent-first CLI principles

- Every command has a narrow, documented contract.
- `--json` returns data without prose where provided.
- Commands must return non-zero for invalid requests and never claim a conversion completed before an adapter reports success.
- `convert` is the synchronous queue-bypassing primitive; `jobs enqueue|list|get|cancel|run-next` are the durable foreground primitives. Remote-device commands remain planned.

## Focused v1 boundary

The implemented conversion path is EPUB-to-PDF only. It intentionally excludes a daemon or detached worker, live progress, automatic retry or backoff, priorities, batching, scheduling, active cancellation of a running queued job, queued-job overwrite, remote execution, and hostile-input process sandboxing. A failed conversion is terminal; trying again creates a new job.

## Execution roadmap

1. Add an authenticated HTTP device agent with capability registration, heartbeat expiry, and artifact checksums.
2. Add mTLS or device-scoped credentials before accepting network jobs or file transfers.

## Security rules

- Treat paths, filenames, metadata, and device messages as untrusted.
- Use argument arrays, never interpolated shell command strings.
- Run converter adapters in isolated temporary directories with size/time limits.
- Verify artifact digest and size before and after transfer.
- Require explicit authorization for every remote device.
