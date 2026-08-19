# Seamless Library-to-Kindle Program

## Destination

Takio becomes the local-first app where a person can drag in books, find the
right title immediately, and deliver a compatible, verified copy to Kindle with
minimal decisions. The workflow remains safe across crashes, explicit about file
ownership, usable offline, and available through both desktop and CLI contracts.

## Product promise

1. **Drag it in.** Files and folders can be dropped into Takio. Every accepted
   book is durably managed or receives a specific, recoverable failure.
2. **Find it.** Search, filters, saved views, and optional federated local-library
   discovery lead to the desired book without browsing the filesystem.
3. **Send it.** Takio selects an attached Kindle-compatible format or creates one,
   verifies delivery, records it in the destination manifest, and can later
   reconcile, update, or safely remove only Takio-tracked copies.

## Existing foundation

- The Electron desktop already supports picker and drag/drop import, searchable
  library browsing, metadata, duplicate review, conversion jobs, destinations,
  and a constrained Bun sidecar protocol.
- The CLI already supports deterministic library operations, verified USB
  delivery, KOReader-aware format preference, rooted Kindle SSH/SCP delivery,
  bounded send-many, and destination inventory/reconciliation.
- Destination synchronization already uses a versioned manifest and removes only
  verified Takio-tracked deliveries.
- Managed files have hashes, ownership provenance, integrity verification,
  migration backups, portable export, and deferred cleanup journals.

## Verified progress on 2026-08-19

- Packaged macOS drag/drop imported a real EPUB through the public dialog, kept
  the source under copy ownership, created the managed copy, found the title by
  search, and closed cleanly under an isolated profile.
- Same-device move imports now use a durable adoption journal, atomic rename,
  fingerprint checks, directory synchronization, deterministic recovery, and
  explicit cross-device rejection.
- Desktop reader delivery supports single and bounded bulk convert-if-needed
  sends. Responses are strictly decoded and correlated to the requested item and
  format before the UI counts a success.
- Desktop reader inventory reports present, missing, and changed Takio-tracked
  deliveries without exposing destructive removal.
- Public CLI acceptance delivered an attached PDF and converted a real EPUB to
  PDF before verified delivery to an isolated Kindle-shaped destination. Both
  appeared as present in the destination manifest inventory.
- Full physical Kindle acceptance remains open because no device was available.

## Program rules

- Preserve the local-first and no-lock-in model. No core workflow requires an
  account or hosted service.
- Preserve clean-room, MIT-compatible implementation. Calibre may be invoked
  through public command-line interfaces or used for behavioral comparison, but
  its code must not be copied or structurally translated.
- Device integrations are opt-in, capability-reported, and bounded by explicit
  security controls. Tests use destination seams and mocked transport boundaries.
- Never silently overwrite caller-owned files, managed library files, or device
  deliveries.
- Cross-device rename (`EXDEV`) is a move failure. Do not silently degrade an
  adopt-by-move request into copy-and-delete.
- Each milestone lands through contract tests, focused implementation tests, full
  workspace gates, and the closest available end-user workflow.

## Milestone order

### 1. Crash-safe drag and adoption

Replace copy-then-delete move imports with an explicit crash-safe adoption state
machine. Perform duplicate preflight before mutation, require same-device atomic
rename, persist recovery state before the rename, fsync the affected directories,
verify the installed fingerprint, and finalize the library row transactionally.
Opening a library must deterministically finish or roll back every pending
adoption without guessing ownership.

Exit criteria:

- Injected crashes at every durable boundary recover without losing or duplicating
  the source bytes.
- `EXDEV` and source changes produce stable failures without copying or deleting.
- CLI, Electron IPC, and desktop import UI carry the explicit import mode.
- Real drag/drop import survives app termination and relaunch.

### 2. Coordinated library service

Introduce one process boundary that owns library mutations and serializes writes.
The desktop stops spawning independent mutating library processes. CLI workflows
either use the same service when available or retain a documented exclusive
foreground path. Read operations remain concurrent where safe.

Exit criteria:

- Two deterministic competing writers cannot produce lock-dependent product
  behavior.
- Shutdown, sidecar failure, and restart preserve truthful operation results.
- Existing one-line CLI and typed desktop wire contracts remain stable.

### 3. Reference resilience and relocation

Record enough identity for referenced files to distinguish missing, moved, and
changed content. Add locate/relink operations and declared reference roots. Add a
safe whole-library relocation command that moves the database, managed items, and
covers as one verified unit.

Exit criteria:

- Missing references are visible and bulk-relinkable without changing ownership.
- Relinking verifies format and fingerprint expectations.
- A relocated library passes integrity verification before the old location is
  released.

### 4. Complete backup products

Keep portable export focused on interoperable active-book data. Add a distinct
full snapshot that includes the catalogue, managed items, covers, jobs, and
operational recovery state needed to resume the exact Takio installation.

Exit criteria:

- Full restore reproduces library, trash, saved views, duplicate state, jobs, and
  pending recovery obligations.
- Portable rebuild remains self-contained and intentionally omits operational
  history.
- Neither backup product overwrites an existing destination.

### 5. Unified discovery

Add a local registry of Takio libraries and federated read-only search. Keep each
library's storage and writes isolated. Integrate fast discovery into the desktop
without making users choose a database before they can search.

Exit criteria:

- Results identify their owning library and open in that context.
- A missing or offline library degrades to an explicit partial result, not a
  blocked search.
- Cross-library mutations and distributed transactions remain out of scope.

### 6. Declarative format capabilities

Evolve the curated catalogue so each format declares recognition, validation,
metadata, conversion, viewing, and delivery capabilities. Desktop and CLI choices
must come from the same registry. Decide whether KFX and AZW are safe opaque
managed formats or remain explicitly unsupported.

Exit criteria:

- UI and CLI never advertise a conversion or delivery path absent from live
  capabilities.
- Adding a curated format does not require duplicated conditionals across product
  surfaces.
- No arbitrary third-party plugin execution is introduced.

### 7. Seamless Kindle delivery

Expose existing USB, KOReader, conversion, manifest, inventory, reconcile, update,
safe removal, and rooted SSH/SCP capabilities through one desktop journey. The
default action chooses the safest compatible format and explains only decisions
that require the user. Rooted transport remains explicit and never contacts a host
without complete per-invocation configuration.

Exit criteria:

- Selecting a book and Kindle can attach or create the preferred format, deliver
  it, verify bytes, and record the manifest in one observable workflow.
- Inventory reports present, missing, and changed deliveries in the desktop.
- Removal deletes only unchanged Takio-tracked files.
- MTP and Amazon Send-to-Kindle remain explicitly gated until a separately
  reviewed transport design is accepted.

### 8. Packaged acceptance and release

Exercise the product promise from the packaged macOS app and standalone CLI.

Exit criteria:

- Drag -> find -> convert if needed -> send -> reconcile -> relaunch passes on a
  packaged build.
- Backup, restore, reference relink, and library relocation pass destructive-edge
  acceptance in disposable directories.
- Available USB and rooted Kindle hardware gates pass, while unavailable hardware
  remains an explicit blocker rather than an inferred success.
- Signing, notarization, release, and rollback documentation is complete.

## Immediate execution slice

The first implementation slice is the durable pending-adoption journal and its
schema migration. It must begin with deterministic tests for recovery before and
after atomic rename, fingerprint mismatch, duplicate discovery, and `EXDEV`.
Only after those tests drive the store state machine should the existing CLI,
Electron, and desktop import surfaces be switched to the new semantics.

This slice is complete. The next implementation slice is the coordinated library
service, while the Kindle milestone continues with safe tracked removal, rooted
transport presentation, and physical-device acceptance.
