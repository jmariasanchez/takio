# Takio Architecture

## Product

Takio replaces the heavyweight, application-centric Calibre workflow with a focused local-first product:

1. A **secure Electron desktop UI** for browsing a local library, managing metadata, delivering books, and following conversions.
2. A **TypeScript CLI**, runnable from Bun during development or as a standalone compiled executable, designed as a dependable interface for humans, AI agents, skills, and automations.
3. A **shared TypeScript domain package** so both interfaces produce identical, validated conversion jobs.

## Monorepo boundaries

| Package | Responsibility | Status |
| --- | --- | --- |
| `@takio/core` | Format catalogue, detection, request validation, device-aware planning | Implemented |
| `@takio/cli` | Structured commands for tools and agents | Implemented: planning, six proven local conversion pairs, durable foreground jobs, and device-aware convert-and-send |
| `@takio/desktop` | Electron shell, context-isolated preload, and React interface | Implemented: library, destinations, conversion queue, native menus, dialogs, and packaging |
| Converter adapters | Declare supported pairs and invoke a real engine safely | Implemented: native EPUB-to-KEPUB plus local `ebook-convert` for five synchronous conversion pairs and four output profiles |
| Controller/queue | Persist local jobs and run one foreground job at a time | Implemented: separate `jobs.sqlite` queue |
| Destination transfer | Detect mounted USB mass-storage recipients and copy verified library files; optionally upload to a caller-specified rooted Kindle SSH target | Implemented: macOS USB mass storage plus gated rooted Kindle SSH/SCP |
| Unsupported device transports | MTP and Amazon Send-to-Kindle integrations | Explicitly unavailable and gated in capability reporting |
| Content server | Foreground authenticated read-only catalog and attached-format delivery | Implemented: loopback HTTP or explicit remote TLS |
| Device agent | Authenticated worker that advertises adapters and capacity | Planned |

A `Destination` is a passive mounted recipient volume, distinct from the planned device agent that will act as an authenticated remote execution worker. Rooted Kindle SSH/SCP is deliberately modeled as a gated transport command, not as discovery: it never contacts a host unless the caller supplies host, user, port, remote root, and optional key for that invocation.

The unnamed library keeps the original data layout. A global validated
`--library <name>` selector resolves to `libraries/<name>/library.sqlite` under
that same data root, with its own managed files and foreground job database.
Explicit `--db` paths remain supported and are mutually exclusive with a named
library selector.

Local `ebook-convert` discovery checks `TAKIO_EBOOK_CONVERT`, then `PATH`, then `/Applications/calibre.app/Contents/MacOS/ebook-convert` on macOS.
EPUB-to-KEPUB does not use that executable. The native transformer validates the
EPUB container, follows the package spine, adds Kobo location spans, preserves
non-transformed resources, and publishes through the same atomic artifact path.
The `metadata extract` command and delivery paths similarly discover
`ebook-meta` through `TAKIO_EBOOK_META`, `PATH`, then the Calibre macOS bundle.
Online candidate lookup discovers `fetch-ebook-metadata` through
`TAKIO_FETCH_EBOOK_METADATA`, `PATH`, then the Calibre macOS bundle. It returns
normalized metadata for review and can publish a bounded, verified cover only
to an absent caller-owned path; applying either remains an explicit library
operation.
Extraction returns normalized metadata and bounded cover facts in one JSON
envelope. Export and send may write the current catalogue metadata and owned
cover only into a newly created delivery copy for KEPUB, EPUB, PDF, MOBI, AZW3,
and DOCX. They report `embedded`, `unsupported`, or `backend-unavailable`; a write
failure removes the copy. Stored and caller-owned sources are never rewritten.

`ebook-convert` is trusted local configuration, not a sandbox; hostile-input resource isolation is not provided.

The conversion queue uses `jobs.sqlite` beside, but independent from, `library.sqlite`. Its CLI is deliberately exact: `jobs enqueue`, `jobs list`, `jobs get`, queued-only `jobs cancel`, history-preserving `jobs retry`, attachment-only `jobs retry-attachment`, one-shot `jobs run-next`, and bounded foreground `jobs drain`. The state machine is `queued` → `running` → `completed` or `failed`, plus `queued` → `canceled`. Retrying a failed or canceled job creates a new queued record at the end of the queue and leaves the terminal record intact. `retry-attachment` returns only a completed job's failed library receipt to `pending`; it does not repeat conversion. `run-next` claims the oldest queued job; `drain` repeats the same runner up to an explicit bound and reports processed and remaining counts. SIGINT or SIGTERM kills the active conversion, records `conversion-cancelled`, and stops the drain before another claim. No daemon claims work in the background.

The caller owns the requested output path, and enqueue refuses a path that already exists. Execution also refuses to overwrite a file that appeared later. A job becomes `completed` only after the output path, nonzero size, and SHA-256 digest are verified and recorded.

The desktop exposes the same contract: **Convert** on an EPUB item opens a native save dialog and adds a ledger entry. It drains queued jobs serially while open, offers **Retry** for failed, canceled, or interrupted work, and retains **Refresh**, **Run next**, and queued-job **Cancel** as manual controls.

`send --convert` is a separate synchronous convenience path. It prefers an
already attached format compatible with the detected destination. If none is
attached, it deterministically selects the first tested conversion target and
source, uses the Kobo or Kindle Calibre output profile, verifies and attaches
the artifact, and then performs the verified destination copy. `--format`
overrides automatic selection. KEPUB is delivered to Kobo with its canonical
`.kepub.epub` filename. Delivery uses the logical book filename rather than the
UUID of an internal managed copy.
Before transfer, supported formats are copied into a private workspace and
materialized with the current catalogue metadata. Bulk export materializes its
new destination files in place and removes any file whose metadata write fails.
Bulk export also accepts the closed `title` and `author-title` filename presets;
both remain flat, sanitized, collision-suffixed, and non-overwriting.
`send-many` reuses the same verified transfer one item at a time for up to 256
distinct IDs and reports every outcome in caller order; it does not implicitly
convert missing formats. `destination rooted-kindle-send` is an explicit SSH/SCP
escape hatch for rooted Kindles, suitable for KOReader directories under
`/mnt/us/...`. It validates host/user/port/key/path input, disables password
authentication, uses strict host-key checking unless the caller opts into
OpenSSH `accept-new`, runs only system `ssh` and `scp` argv arrays with bounded
timeouts, uploads to a private `.takio-partial-*` remote name, verifies remote
SHA-256 when `sha256sum` exists or size otherwise, and publishes by non-overwrite
hard-link before removing the partial. USB mass storage remains unchanged.
`library update-many` applies one validated patch with the same bound and accounting.

`library verify` opens `library.sqlite` read-only with SQLite query-only mode.
It refuses unsupported schemas rather than migrating them, then reuses the
same full verifier that gates schema migration: SQLite integrity, foreign keys,
stored record parsing and path containment, duplicate-review records, and the
stored byte count and SHA-256 fingerprint of each managed format. Referenced
files remain caller-owned and are counted but not required to be online. The
command reports facts or fails; it never repairs state.

`library backup` serializes a consistent database snapshot through SQLite,
copies the managed formats named by that snapshot plus all managed covers, and
reruns the full verifier before publishing a versioned manifest. It refuses an
existing destination. `library restore-backup` validates the manifest and
snapshot again, stages the database and owned files beside the destination,
and atomically publishes a new library directory. Restore never replaces an
existing directory. Caller-owned references and the independent conversion-job
ledger are deliberately outside the snapshot.

The separate portable path is book-centered rather than database-centered.
`library portable-export` writes one OPF file per active book and copies every
format and cover, including referenced files, into an absent directory with a
SHA-256 manifest. `library rebuild` validates all paths, sizes, hashes, and OPF
records before creating storage, then reconstructs an absent library with only
managed artifacts and runs the full integrity verifier before atomic publish.
Trash, saved views, duplicate-review state, and conversion jobs are not portable
book data and remain outside this format.

`library catalog` maps those same active book records to JSON, CSV, or HTML and
omits every local source and cover path. Publication is exclusive and reports
the byte count and SHA-256 digest. `serve` reuses that path-free record shape in
a bounded read-only HTTP API. It starts only in the foreground, authenticates
all requests with a fresh per-run bearer token, and resolves downloads through
stored item IDs and attached format IDs. Loopback is the default; non-loopback
binding requires an explicit flag and a supplied TLS certificate/key pair.

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
- Every success and failure has a one-line machine envelope with a stable error code; discovery commands retain readable output unless `--json` is requested.
- `capabilities` reports the protocol version, structured-input limits, schema, backup, portable and catalog versions, exact conversion pairs, remote policy, live backend availability, available gated rooted-Kindle SSH/SCP transport, and explicitly unavailable gated MTP and Send-to-Kindle transports without requiring agents to scrape help text.
- Structured requests accept bounded inline JSON, stdin with `-`, or a file with `@path`.
- Commands must return non-zero for invalid requests and never claim a conversion completed before an adapter reports success.
- Diagnostic commands are read-only: `library verify` never creates, migrates, or repairs a library.
- `convert` is the synchronous queue-bypassing primitive; `send --format ... --convert` composes conversion, attachment, and verified USB mass-storage delivery; `destination rooted-kindle-send` is an explicit, separately configured rooted-Kindle SSH/SCP upload; `jobs enqueue|list|get|cancel|retry|run-next` are the durable foreground primitives. Remote-device agent commands remain planned.

## Focused v1 boundary

The implemented conversion paths are EPUB-to-KEPUB, EPUB-to-PDF,
EPUB-to-AZW3, and DOCX, HTML, or TXT to EPUB. They intentionally exclude a
daemon or detached worker, live backend percentage progress, automatic retry
or backoff, priorities, scheduling, queued-job overwrite, remote conversion, and
hostile-input process sandboxing. Bounded batch operations and foreground
draining are explicit; a signal cancels the active conversion. A failed
conversion is terminal; trying again creates a new job.

## Execution roadmap

1. Add an authenticated HTTP device agent with capability registration, heartbeat expiry, and artifact checksums.
2. Add mTLS or device-scoped credentials before accepting network jobs or file transfers.

## Security rules

- Treat paths, filenames, metadata, and device messages as untrusted.
- Use argument arrays, never interpolated shell command strings.
- Run converter adapters in isolated temporary directories with size/time limits.
- Verify artifact digest and size before and after transfer.
- Require explicit authorization for every remote device.
