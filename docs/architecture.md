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

## Durable conversion-to-library handoff

A conversion linked to a library item crosses three separate durability boundaries:

1. **Output publication:** the converter publishes the verified artifact at the caller-chosen path without overwriting an existing file. The caller owns this output.
2. **Conversion completion:** `jobs.sqlite` records `completed` with the artifact byte count and SHA-256 digest. This status is conversion truth only; it does not claim that the format is present in the library.
3. **Attachment receipt:** the library transaction copies the artifact into managed storage and records the format in `library.sqlite`; the job then records a separate `attached` receipt. A completed linked job remains `pending` until that receipt is durable, or becomes `failed` with a specific attachment error.

`jobs run-next` first recovers dead `running` conversions, without adopting an output whose completion was never recorded. It then reconciles the oldest `completed` job with a `pending` attachment before claiming another queued conversion. Reconciliation revalidates the caller-owned output against the completed job, checks the target item and format, and compares the exact attached-format hash when a format already exists. A matching hash is an idempotent success; a different hash is a conflict and is never overwritten. If the library commit succeeds but writing the job receipt fails, the job stays `pending` so the next run can recover it by hash.

| Crash or restart boundary | Durable truth | Recovery behavior |
| --- | --- | --- |
| After output publication, before conversion completion | Conversion is not completed | Mark the abandoned `running` job interrupted; do not adopt or overwrite the possibly published output. |
| After conversion completion, before library attachment | Conversion is `completed`; attachment is `pending` | Revalidate the output and retry attachment before claiming new queued work. |
| After the library commit, before the attachment receipt | Library format exists; attachment is still `pending` | Recompute the attached-format hash; a match records `attached`, while a mismatch reports a conflict. |
| After the attachment receipt | Conversion is `completed`; attachment is `attached` | No recovery action. The receipt is terminal, so later user removal does not resurrect the format. |

Attachment failure never rewrites a completed conversion as failed and never deletes the caller-owned output. Missing library items, conflicting formats, missing or changed output, and library-storage failures are reported as attachment failures that tell the user where the converted file remains. Retrying a failed attachment is explicit; there is no automatic retry loop.

This handoff adds no built-in ebook reader or viewer. Opening books continues to use the operating system's default application; reader functionality is outside this conversion-durability boundary.

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
