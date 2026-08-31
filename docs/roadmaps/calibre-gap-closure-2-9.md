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

The latest whole-program public-interface evidence is recorded in
[`calibre-gap-closure-acceptance-audit.md`](calibre-gap-closure-acceptance-audit.md).

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

Status: complete. Selected-book desktop slice delivered in `663541e` and hardened in
`3db7264`, `e944aee`, `4a8e3ad`, `8582eee`, and `a99670a`. Equivalent
selected-book TUI review delivered in `67d36f1` and hardened in `cbce02b` and
`502b8c5`. Strict bounded bulk contracts and native discovery were delivered in
`b69e6e0`, `4620d6b`, and `1b77e9a`; the accessible desktop review workflow was
delivered in `0c4dd6b` and hardened in `4bd9019` and `a171891`. Native discovery
was hardened in `61527de`, with the final cross-runtime item-id alignment in
`c1a955e`. Path-free candidate-cover contracts and Rust staging were delivered in
`0805fbf`, `f219c40`, and `9be1e1c`; desktop and selected-book TUI review landed
in `8786f15` and `0e9eff0`. Rust staging and apply were finalized in `d2495de`
and `7f0d880`, TUI cleanup and compact review in `7b12949`, and desktop protocol,
discard, and lifecycle handling in `4af244d`, `60e1930`, `867790f`, and
`d0ff592`, with exact applied-field set correlation in `ff88956`.

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
- Candidate covers stay outside metadata patches and never expose filesystem
  paths. Discovery stages bounded, expiring artifacts under Takio ownership and
  returns only an opaque token plus media type, extension, byte count, and digest.
- Desktop selected-book and bulk review show verified previews through a contained
  `takio-cover` protocol. Desktop and TUI keep cover selection unchecked until the
  user explicitly opts in, including cover-only application.
- Rust binds each staged artifact to its item, candidate identity, source,
  provenance, digest, size, and media pair. Metadata, audit, and durable cover
  reference commit together; failures remove the unpublished durable copy while
  retaining the stage for retry, and successful apply consumes it.
- Staging quota and garbage collection use a bounded cross-process coordination
  lock. Apply claims a stage before publication, restores it on transaction
  rollback, rejects replay after commit, and returns the committed item without a
  fallible post-commit hydration step.
- Selected-book and bulk desktop workflows reject cross-item and duplicate
  candidates, treat applied fields as an exact unordered selection, discard
  abandoned stages on refresh, item change, skip, close, cancellation, unmount,
  metadata-only apply, and invalid or stale responses, and isolate cancellation
  tokens across close and reopen lifetimes.
- Final exact-head validation passed all Rust, contract, desktop, and workspace
  tests and builds. Checksummed standalone CLI and bundled desktop-sidecar
  acceptance exercised path-free cover discovery, explicit metadata and cover
  application, replay rejection, stage consumption, compact TUI rendering, and
  terminal restoration.

Remaining acceptance work:

- Consider a TUI multi-select queue for bulk review after the desktop workflow has
  accumulated real usage evidence; the selected-book TUI and public CLI already
  use the same validation and apply engine.

#### B2. Virtual libraries and advanced organization

Status: the virtual-library, native-query, bounded structured-query, bounded
custom text-field, and bounded save-to-disk organization vertical slices are
delivered in `48caa27`, `ffaf197`, `d5aaeb5`, `428fdc4`, `edd69a6`, `0f3774d`,
`3e892ec`, `cde5a4b`, and `f5aaf11`. Library-defined typed custom columns,
reusable group rules, arbitrary user-authored save-to-disk grammar, and richer
bulk organization remain open.

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

Delivered evidence:

- Saved definitions are exposed as named virtual libraries through the shared
  contract, Rust CLI/store, and desktop library sidebar. The legacy
  `saved-views` command and response vocabulary remain compatible.
- A selected virtual library contributes a persisted base query and facet scope.
  Session search and filters are applied conjunctively inside it, while session
  sort and paging remain independently changeable. `All books` explicitly exits
  the scope.
- The checksummed standalone release and packaged desktop sidecar both passed an
  external public-interface workflow that saved and reopened a virtual library,
  combined it with session text and author filters, proved same-facet
  contradictions return zero items, rejected a missing scope as `not-found`, and
  emitted one JSON envelope with empty stderr.
- Fresh packaged processes saved the same virtual-library ID with different
  definitions in two named libraries and reopened the correct isolated
  definition for each selector. Desktop reducer, storage, and DOM tests cover
  restoration of the active virtual-library ID; the rebuilt macOS ARM64 desktop
  bundle passed local bundle verification.
- The exact-head 10,000-book public Rust query gate measured 64.18 ms p95 after
  the virtual-library change. The TypeScript reference-store gate measured
  110.0 ms p95. Both remain below the 150 ms roadmap target.
- `structured-v1` is an explicit, bounded search mode across the shared contract,
  Rust store/CLI, persisted virtual libraries, desktop search controls, and the
  native performance gate. It supports quoted values, implicit conjunction,
  `and`, `not`, and fixed fields for title, authors, tags, series, publisher,
  languages, formats, identifiers, and description. Literal mode remains the
  compatibility default.
- The checksummed standalone release and packaged desktop sidecar both passed an
  external real-SQLite workflow covering every structured field, quoting,
  negation, literal compatibility, virtual-library composition, malformed-query
  rejection without persistence, strict syntax decoding, one JSON envelope, and
  empty stderr.
- The packaged 10,000-book, 15,000-format gate measured 55.44 ms maximum p95 for
  the standalone release and 57.83 ms for the desktop sidecar. Structured-only
  p95 was 49.93 ms and 50.68 ms respectively, below the 150 ms target.
- Existing bounded `customMetadata` values are now user-visible as editable text
  rows in the desktop metadata editor and sorted `#key` entries in the inspector.
  Explicit keep, replace, and clear semantics preserve the internal candidate
  audit field, while row-addressable validation enforces safe lowercase keys,
  uniqueness, 64 user fields, and 16 KiB values.
- Rust literal search now includes user custom keys and values, and
  `structured-v1` accepts safe `#key:value` terms with quoting, conjunction,
  negation, and virtual-library composition. Malformed and reserved audit keys
  return `invalid-query`; queries are read-only and parameterized.
- The checksummed standalone release and desktop sidecar passed an external
  real-SQLite workflow covering edit, audit-preserving replacement, literal and
  structured lookup, negation, virtual-library composition, invalid-key
  rejection, JSON and CSV catalogues, all three authenticated HTTP catalog
  routes, portable export/rebuild, and malicious reserved-key OPF rejection.
  User fields remained visible while `takio_metadata_audit` and its source
  details were absent from public catalogues and portable interchange. Every
  machine command emitted one JSON envelope with empty stderr.
- After the custom-field query expansion, the packaged 10,000-book,
  15,000-format gate measured 75.57 ms p95 for the standalone release and
  75.09 ms for the desktop sidecar. Structured-only p95 was 66.25 ms and
  68.96 ms respectively, below the 150 ms target.
- `export-many` now accounts for every attached format rather than exporting only
  the primary format. Each filename carries the full SHA-256 item identity, and
  the shared contract plus desktop dialog expose fixed `flat`, `author`, and
  `series` folder presets with safe `Unknown author` and `Unsorted` fallbacks.
- The exact-head standalone release and desktop sidecar both passed an external
  real-filesystem workflow with same-title books, a multi-format item, long
  Unicode titles, all three folder presets, author-title naming, exact bytes and
  digests, repeat no-overwrite behavior, duplicate and unknown request rejection
  before destination creation, and symlink containment. Each machine command
  emitted one JSON envelope with empty stderr.
- This slice deliberately does not accept arbitrary path expressions. Richer
  Calibre-style save-to-disk grammar remains blocked on a separately designed,
  bounded template language rather than exposing filesystem paths or shell-like
  interpolation.
- Bounded per-book text fields are not full Calibre custom-column parity. A
  future slice still needs library-level definitions and labels, typed or
  multi-valued data, delta bulk updates, table columns, sorting, facets,
  definition-aware Calibre import, and portable definition round-trip.

### Track C: Operational maturity foundation

#### C1. Diagnostics and observability

Status: three production vertical slices delivered in `70ea980`, `fb8d83c`,
`def3c98`, `028964e`, `48caa27`, and `ffaf197`. C1 remains open for durable
operation records, queue/server/device summaries, and import/merge/server
latency gates. The shipped Rust query path now satisfies the 150 ms roadmap
target.

Deliver:

- Structured diagnostic bundle with redaction.
- Durable operation and automation audit records.
- Storage, queue, server, and device health summaries.
- Startup, query, import, merge, and server latency benchmarks in CI.

Accept when:

- A support bundle contains enough evidence to diagnose a failed operation while
  excluding bearer tokens, private keys, and ebook contents.
- Performance regressions fail reproducible gates.

Delivered evidence:

- `takio library diagnostics --dest <path>` atomically publishes a versioned,
  bounded JSON support bundle without overwriting an existing destination.
- The bundle reports application identity, platform and architecture, library
  integrity or a stable verification failure, database presence and byte counts,
  managed item and cover tree counts, and explicit capability flags.
- Bundle contents omit library paths, filenames, titles, ebook bytes, content
  hashes, raw operating-system errors, bearer tokens, private keys, and other
  secrets. Public contract tests reject unknown or path-bearing fields.
- Library verification failure still produces a useful bundle without creating or
  mutating the missing or incompatible library.
- Desktop Library Health exposes the same operation through a strict fixed Electron
  argument mapping and response decoder, with explicit privacy copy and accessible
  pending, success, and error states.
- The checksummed macOS ARM64 release binary and packaged desktop sidecar both
  passed public acceptance for exact byte/digest reporting, redaction, failed-store
  capture, one-record JSON envelopes, and no-overwrite behavior. Release SHA-256:
  `5e25bbbffed92560629d69c7b766fc94ac8db101054e5893038c0e9f96ab119d`.
- CI and release validation now execute an end-to-end native Rust query benchmark
  through the shipped CLI boundary against a deterministic 10,000-book,
  15,000-format current-schema fixture. The benchmark validates the public query
  envelope, includes process startup, schema verification, hydration, sorting,
  facets, paging, and JSON serialization, and enforces the 150 ms p95 roadmap
  target.
- `ffaf197` moved author, tag, series, language, and format filtering into SQLite
  before hydration. Three pre-fix release runs reproduced native p95 between 214
  and 232 ms. Repeated optimized runs measured 55-60 ms, and the definitive
  exact-head run measured 60.0 ms. The TypeScript reference-store gate measured
  122.8 ms. Both shipped and reference paths therefore pass the same 150 ms gate.

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

1. Complete C1 durable operation audits and broader queue/server/device health
   summaries, then add import, merge, and server latency gates.
2. Extend B2 with custom organization columns/templates and richer reusable
   bulk workflows.
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
