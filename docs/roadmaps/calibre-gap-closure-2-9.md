# Calibre Gap Closure Program: Areas 2 Through 9

> Active product map. This program supersedes earlier permanent exclusions for
> reading, editing, browser reading, and extension workflows. Those capabilities
> are now in scope, but they remain phased and acceptance-gated.

## Destination

Takio provides a credible Calibre alternative for library management, metadata,
devices, reading and editing, automation, content serving, reliability, and
desktop use while preserving its local-first model and deterministic Rust JSON
interface.

Conversion-engine independence is not part of this program. Takio continues to
use public Calibre executables where they remain the strongest bounded backend.

## Operating principles

1. Deliver vertical slices through the Rust store, CLI/service protocol, desktop,
   and TUI where the workflow belongs.
2. Preserve one-line JSON envelopes and explicit side effects for agents.
3. Never make destructive library, device, or metadata decisions silently.
4. Prefer typed operation registries over arbitrary shell or plugin execution.
5. Establish real scale, recovery, security, and hardware evidence before
   advertising support.
6. Reuse one domain capability across desktop, TUI, automation, and server
   surfaces rather than creating parallel implementations.

## Decisions so far

- The first slice, duplicate review and merge parity in Rust, is delivered across
  the sidecar, direct CLI, service protocol, and desktop contract.
- Metadata enrichment remains review-first. Extracted, filename-derived, and
  online candidates never overwrite user metadata without an explicit apply.
- Device support gains a transport-neutral identity and capability model before
  adding MTP, wireless, or email transports.
- Built-in reading is now in scope. It starts with a secure EPUB reading core and
  durable local progress, then annotations and browser reuse. External opening
  remains available throughout.
- Editing starts with verified-copy Calibre editor handoff. A native EPUB editor
  follows only after the reader and EPUB inspection model are stable.
- Extensibility starts with a manifest-driven recipe runner over curated Takio
  operations. Arbitrary executable plugins remain excluded until at least two
  real integrations cannot be served by the typed registry.
- The content server evolves from its current foreground download API. Lifecycle
  controls and real HTTP tests come before remote TLS, users, OPDS, and browser
  reading.
- Operational baselines and recovery contracts precede new platform claims.

## Dependency-ordered delivery map

### Track A: Restore library parity after the Rust migration

#### A1. Duplicate review and merge

Status: delivered in `3afc154` and integrity-hardened in `aa56bd6`.

Deliver:

- Conservative signals for same content, identifier, and normalized title/author.
- Stable review tokens, paging, scan accounting, keep-both, and reopen.
- Atomic merge of selected formats, metadata policy, and cover policy.
- Ownership-safe cleanup and stale-review rejection.
- Direct CLI and persistent service commands compatible with the desktop bridge.

Accept when:

- Existing duplicate-review desktop tests pass against the Rust sidecar.
- CLI integration tests cover list, keep, reopen, merge, stale tokens, rollback,
  and managed versus referenced file ownership.
- `capabilities` no longer lists `library duplicates` as unavailable.

Evidence:

- Rust unit and CLI integration tests cover stable scans, keep/reopen,
  stale-review rejection, atomic merge rollback, service envelopes, and managed
  file ownership after the merged source is purged.
- The release binary completed an end-to-end duplicate workflow through both the
  direct CLI and persistent library service, including metadata and format merge.
- Full workspace formatting, linting, tests, and builds pass with the Rust sidecar
  advertising duplicate support.

#### A2. Complete existing migration and recovery commands

Status: delivered across `3157ba3`, `704aa37`, `31dce69`, `83cfd4e`,
`b00fefed`, `3763ce8`, `6a0d489`, `ed1c845`, `234722b`, `b613f32`,
`58f31f0`, and `4228bb0`.

Deliver:

- Read-only Calibre library import with explicit conflict accounting.
- Import watching with bounded cycles and durable observations.
- Portable export and verified rebuild in Rust.
- Schema migration support from every previously shipped Takio schema, with
  pre-migration backup and rollback evidence.

Accept when:

- A frozen Calibre fixture imports without modifying its source library.
- Watch restart does not duplicate already-accounted files.
- Portable export reconstructs a byte-equivalent managed library.
- Migration failure leaves the original library readable.

Evidence:

- The native Calibre importer preserves rich metadata, multiple formats, covers,
  bounded custom columns, live-WAL visibility, and source ownership. Focused
  malicious-path, symlink, hard-link, malformed-schema, and contract-boundary
  regressions pass.
- Import watching records durable source fingerprints, suppresses unchanged files
  across cycles and restarts, retries failures, reprocesses changes, rejects
  overlap with Takio-owned paths before side effects, and exits an active scan on
  `SIGINT` or `SIGTERM` with one bounded response.
- Portable export and rebuild preserve item IDs, metadata, format order, exact
  bytes, covers, and per-format timestamps. Source manifests, OPF references,
  media types, digests, symlinks, paths, and destination publication are verified
  before commit.
- Schema v11 migrates every canonical v1-v10 fixture under one writer lock. It
  retains a verified no-overwrite backup, supports safe retry after a rolled-back
  transient failure, rejects stale backups and spoofed schemas, proves WAL-safe
  rollback, preserves owned relative paths, and enforces the canonical domain
  schema and indexes.
- The checksummed macOS ARM64 release binary completed Calibre import, watch and
  restart, active-scan signal cancellation, overlap rejection, portable rebuild,
  candidate apply, and public v1-to-v11 migration workflows. The packaged desktop
  bundle embeds the same Rust schema-11 sidecar.

Operational follow-ups move to Track C: freeze an independently recovered v10
fixture, bound migration retry verification memory for very large databases, run
native Rust scale and soak gates, and execute migration and path acceptance on
Windows rather than inferring it from cross-platform dependencies.

### Track B: Metadata and power-library workflows

#### B1. Candidate review in desktop and TUI

Status: selected-book desktop slice delivered in `663541e` and hardened in
`3db7264`, `e944aee`, `4a8e3ad`, `8582eee`, and `a99670a`. Equivalent
selected-book TUI review delivered in `67d36f1` and hardened in `cbce02b` and
`502b8c5`. Strict bounded bulk contracts and native discovery were delivered in
`b69e6e0`, `4620d6b`, and `1b77e9a`; the accessible desktop review workflow was
delivered in `0c4dd6b` and hardened in `4bd9019`.

Deliver:

- Candidate generation from embedded metadata, filename patterns, and optional
  online lookup.
- Side-by-side field differences, provenance, and explicit field-level apply.
- Bulk candidate review with bounded concurrency and cancellation.

Accept when:

- Applying a candidate updates only selected fields.
- User-authored values survive refresh and failed lookups.
- Desktop, TUI, and CLI observe identical resulting metadata.

Delivered evidence:

- Strict shared schemas, fixed Electron argument mappings, request-correlated
  renderer decoding, and an accessible field-by-field desktop review surface are
  integrated for one selected book.
- Candidate provenance is bound to the requested item in the contract, renderer,
  UI, and Rust engine. Cross-item and stale list/apply responses are rejected
  before mutation.
- Explicit nulls use clear semantics, omitted fields remain unchanged, selected
  fields alone are applied, and a bounded full provenance audit is stored in
  `takio_metadata_audit`.
- The Rust store validates candidate, ordinary-update, and duplicate-merge values
  against the shared metadata domain before commit. Invalid dates, languages,
  authors, identifiers, and custom metadata cannot poison later desktop reads.
- The audit field is system-owned: ordinary updates and duplicate merges preserve
  it and reject forgery, while trusted candidate application can replace it with a
  newly validated record.
- Item-scoped filename discovery uses the preserved import title after managed
  publication, while provenance still identifies the actual managed source path.
- Real DOM interaction tests cover stale-response races, keyboard focus, and live
  status. The final checksummed package covers managed filename discovery, item
  identity, invalid-value rejection without mutation, null clearing, audit
  persistence and ownership, and stable one-line machine envelopes.
- The Rust TUI discovers local candidates without blocking terminal input, keeps
  online lookup behind an explicit action, compares current and proposed values,
  supports candidate and field selection, confirms application, and records the
  same bounded provenance audit as CLI and desktop. Wide and compact render tests,
  state tests, and a packaged PTY workflow prove selective application, cancel
  safety, stable item selection after title reordering, stale-result recovery,
  terminal control sanitization, compact confirmation affordances, Ctrl-C exit,
  terminal restoration, and command-palette access.
- Bulk discovery accepts one strict schema-versioned request for at most 64 unique
  books with safe ASCII item ids up to 128 bytes, matching the stored item domain
  while keeping every compact schema-valid request within the 16 KiB structured-
  input transport. It preserves request order, uses no
  more than four Rust workers, produces exactly one terminal outcome per book,
  and does not mutate the library. Signal cancellation accounts for unfinished
  books explicitly and terminates active metadata backends.
- The desktop bulk workflow uses fixed concurrency two, keeps online lookup behind
  explicit opt-in, stops scheduling on cancellation, preserves bridge failure
  codes, treats deletion during discovery as missing, and validates exact ordered
  discovery and final-review counts against the shared contract.
- Users review one book at a time with the same item-bound candidate and selective
  field controls as the selected-book workflow. Approved mutations remain
  sequential and transactional; skipped, missing, failed, and canceled books are
  retained in the final report.

Remaining acceptance work:

- Integrate fetched cover choice into the candidate contract and review surfaces.
- Consider a TUI multi-select queue for bulk review after the desktop workflow has
  accumulated real usage evidence; the selected-book TUI and public CLI already
  use the same validation and apply engine.

#### B2. Virtual libraries and advanced organization

Deliver:

- Saved views promoted to named virtual libraries.
- Structured query grammar, custom metadata columns, reusable sort/group rules,
  and configurable save-to-disk templates.
- Bulk conversion, send, export, removal, and metadata operations with per-item
  outcomes and retryable failures.

Accept when:

- A 10,000-book fixture keeps warm query and facet p95 within 150 ms.
- Virtual-library state survives relaunch and named-library switching.
- Every bulk request accounts for every selected item.

### Track C: Operational maturity foundation

#### C1. Diagnostics and observability

Deliver:

- Structured diagnostic bundle with redaction.
- Durable operation and automation audit records.
- Storage, queue, server, and device health summaries.
- Startup, query, import, merge, and server latency benchmarks in CI.

Accept when:

- A support bundle contains enough evidence to diagnose a failed operation while
  excluding bearer tokens, private keys, and ebook contents.
- Performance regressions fail reproducible gates.

#### C2. Recovery and contention

Deliver:

- Multi-process and concurrent-writer tests for store mutations.
- Crash recovery tests for import, merge, migration, queue attachment, and backup.
- User-facing recovery actions in desktop and TUI.

Accept when:

- Injected termination at every publication boundary leaves either the old or
  new valid state, never a mixed state.
- Recovery actions are idempotent and report what changed.

### Track D: Device ecosystem

#### D1. Device identity and capabilities

Deliver:

- Stable `ReaderDevice`, `DeviceTransport`, and `DeviceCapabilities` concepts.
- Persistent device identity independent of mount path.
- Inventory, free-space, supported-format, collection, and transfer policies.
- A device simulator used by CLI, desktop, and CI acceptance tests.

Accept when:

- The same device is recognized after remounting at a different path.
- Send chooses an existing compatible format before conversion.
- Real Kobo and mass-storage Kindle remount tests verify hashes and readability.

#### D2. Additional transports

Deliver in order:

1. Linux and Windows mass storage.
2. MTP behind a separately packaged adapter.
3. Local-network wireless delivery.
4. Email and vendor delivery adapters with explicit credential storage.

Accept each transport only with real hardware or provider evidence, resumable
failure handling, and an honest capability report.

### Track E: Reading and editing

#### E1. Secure local reader

Deliver:

- EPUB navigation, typography, themes, search, table of contents, and keyboard
  operation in a sandboxed reading surface.
- Durable per-book progress and reading preferences.
- Strict resource resolution that cannot escape the selected book.

Accept when:

- A malicious EPUB fixture cannot read local files or execute privileged APIs.
- Progress survives relaunch and format replacement without corrupting library
  metadata.
- Screen-reader, keyboard, zoom, and contrast acceptance passes.

#### E2. Annotations and browser reuse

Deliver:

- Highlights, notes, bookmarks, export, and stable location migration.
- The same reading core embedded in the authenticated content server.

Accept when:

- Annotations survive normal EPUB repackaging or are reported as orphaned with a
  recovery path.
- Browser and desktop reading agree on progress under explicit user identity.

#### E3. Editing

Deliver in order:

1. Verified-copy external Calibre editor handoff and explicit re-import.
2. EPUB structure inspection and repair suggestions.
3. Native source editing with validation, preview, undo, and transactional save.

Accept when no editor path can mutate the only managed copy without a recoverable
snapshot.

### Track F: Automation and extensibility

#### F1. Manifest-driven recipes

Deliver:

- Versioned recipe manifests.
- Typed operation registry with input/output schemas, mutability, retry safety,
  required capabilities, and resource limits.
- Durable run and step ledger with idempotency keys, cancellation, and resume.
- Initial operations for import, metadata candidates/apply, conversion, attach,
  catalog, export, and send.

Accept when:

- `import -> review/apply -> convert -> attach -> send` resumes safely after an
  injected interruption.
- Recipes cannot execute arbitrary commands or access undeclared paths.

#### F2. Extension boundary

Only after two real integrations prove the need, define signed adapters with
capability permissions, compatibility policy, isolation, and lifecycle controls.

### Track G: Content service

#### G1. Production local service

Deliver:

- Real socket-level integration tests.
- Start, stop, status, readiness, graceful shutdown, and port-conflict recovery.
- Covers, search/filtering, OPDS, HEAD, ranges, conditional responses, and stable
  scoped download links.

Accept when:

- Desktop can manage the service lifecycle without orphaning processes.
- Large downloads resume correctly and catalog responses remain path-free.

#### G2. Remote multi-user service

Deliver:

- TLS, persisted users, password hashing, token rotation and revocation,
  per-library scopes, rate limiting, audit log, and session expiry.
- Browser reader integration after Track E1.

Accept when:

- Independent security review covers authentication, authorization, request
  bounds, ebook resource isolation, and secret storage.

### Track H: Desktop product maturity and distribution

#### H1. Durable preferences and accessibility

Deliver:

- Versioned preferences for layout, reading, devices, server, and automation.
- WCAG 2.2 AA keyboard, focus, announcement, contrast, zoom, and reduced-motion
  acceptance across complete workflows.
- Localization infrastructure and pseudo-localization before translated releases.

#### H2. Cross-platform and support

Deliver:

- Signed and verified macOS Intel, Linux, and Windows desktop packages.
- Update, rollback, diagnostics, migration, and uninstall documentation.
- Task-oriented user guide, CLI reference, troubleshooting, and compatibility
  matrix generated from executable capabilities where possible.

Accept when each platform passes clean-install, upgrade, rollback, library reopen,
conversion-backend discovery, device simulation, and uninstall-with-data-retained
journeys.

## Current frontier

1. Complete B1 with fetched cover candidates and review-surface selection.
2. Establish C1 production diagnostics and native Rust scale benchmarks.
3. Specify D1 device identity and simulator using real remount evidence.
4. Prototype E1 secure EPUB reader resource isolation.
5. Specify F1 recipe manifest and operation registry.
6. Harden G1 with socket-level tests and lifecycle controls.
7. Inventory H1 accessibility and durable-preferences gaps per workflow.

These frontier items can proceed in parallel now that A1 and A2 have established
the restored Rust service, recovery, and interoperability patterns.

## Not yet specified

- Annotation location migration algorithm.
- Native EPUB editor document and undo model.
- MTP adapter packaging and licensing.
- Plugin signing authority and distribution channel.
- Remote server account recovery and federation policy.
- Commercial metadata-provider terms and quotas.

## Out of scope

- DRM removal or circumvention.
- Automatic destructive synchronization.
- Copying or translating GPL Calibre implementation code.
- A Takio-owned general-purpose conversion engine.
