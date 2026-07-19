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
| `@takio/cli` | Structured commands for tools and agents | Implemented: planning only |
| `@takio/desktop` | Tauri v2 native shell and minimalist React interface | Implemented: UI shell |
| Converter adapters | Declare supported pairs and invoke a real engine safely | Planned |
| Controller/queue | Persist jobs, retries, cancellation, and event history | Planned |
| Destination transfer | Detect mounted USB mass-storage recipients and copy verified library files | Implemented: macOS |
| Device agent | Authenticated worker that advertises adapters and capacity | Planned |

A `Destination` is a passive mounted recipient volume, distinct from the planned device agent that will act as an authenticated remote execution worker.

## Agent-first CLI principles

- Every command has a narrow, documented contract.
- `--json` returns data without prose where provided.
- Commands must return non-zero for invalid requests and never claim a conversion completed before an adapter reports success.
- Future `convert`, `job get`, `job wait`, and `device register` commands will be stable skill primitives.

## Execution roadmap

1. Define a `ConverterAdapter` contract in `@takio/core`: capability list plus a typed `convert(job)` result.
2. Implement a local adapter around a user-installed converter. Start with Calibre's `ebook-convert` only as a backend, then evaluate Pandoc/LibreOffice by format pair.
3. Create a SQLite-backed local queue and add CLI execution commands (`convert`, `jobs`, `cancel`).
4. Expose the same queue through Tauri commands; replace UI sample data with real domain state.
5. Add an authenticated HTTP device agent with capability registration, heartbeat expiry, and artifact checksums.
6. Add mTLS or device-scoped credentials before accepting network jobs or file transfers.

## Security rules

- Treat paths, filenames, metadata, and device messages as untrusted.
- Use argument arrays, never interpolated shell command strings.
- Run converter adapters in isolated temporary directories with size/time limits.
- Verify artifact digest and size before and after transfer.
- Require explicit authorization for every remote device.
