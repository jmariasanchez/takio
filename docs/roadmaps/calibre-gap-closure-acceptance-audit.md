# Calibre Gap Closure Whole-Program Acceptance Audit

Date: 2026-08-31

Accepted implementation head: `d5aaeb5`

This audit closes the feedback loop over the work completed so far. It does not
claim that Calibre gaps 2 through 9 are complete. It separates observed public
behavior from automated regression evidence and from requirements that remain
open or externally blocked.

## Acceptance paths exercised

Two independently packaged Rust executables completed the same public workflow:

- Standalone release: `dist/releases/takio-v0.1.0-macos-arm64`
  - SHA-256: `a557b3be407f18b86e8bcb59ebf59e19e5a2b0f6100e326de012fb6c0a0c0ee9`
- Desktop sidecar:
  `apps/desktop/release/mac-arm64/Takio.app/Contents/Resources/bin/takio-library-engine`
  - SHA-256: `c6b727dac801bd18206f9a28a512ea93c46554d1cac75ffbe23bfe7f13fab1f5`

The acceptance harness is retained outside the repository at
`$JCODE_SCRATCH_DIR/takio-program-acceptance.py`. It creates isolated data, but
all application behavior crosses the real packaged CLI, foreground HTTP server,
filesystem, SQLite, mounted-destination, and PTY interfaces. It does not call
Rust internals or copy application source.

Both artifacts reported:

- `implementation: rust`
- library schema version 11
- no unsupported commands
- exactly one JSON envelope and empty stderr for every machine command

The macOS ARM64 desktop bundle was rebuilt and passed the repository bundle
verifier in local mode. Distribution signing, notarization, stapling, and
Gatekeeper were not exercised because distribution credentials were not used.

## Requirement-to-observation traceability

| Requirement | Concrete check | Observed result | Remaining constraint |
|---|---|---|---|
| A1 conservative duplicate evidence and stable public commands | Imported two packaged-CLI books, assigned a shared identifier, and called `library duplicates list`; full Rust tests cover keep, reopen, merge, stale tokens, rollback, service envelopes, and ownership | One unreviewed pair was returned. `capabilities.unsupportedCommands` was empty. The complete Rust suite passed. | None for the shipped A1 scope |
| A2 portable reconstruction | Called packaged `library portable-export`, rebuilt into a new database, then listed it | Two books and their managed formats were reconstructed and readable | Independent Windows acceptance remains open |
| A2 backup and recovery | Called packaged `library backup`, `library restore-backup`, and `library verify` | Restored schema 11 contained two active books and two verified managed formats | Large-library retry-memory and soak evidence remain open |
| A2 Calibre import, watch, and schema migration | Exact-head Rust integration suite exercises frozen Calibre input, live WAL, restart accounting, signal cancellation, v1-v10 migration, backups, rollback, spoofed schemas, and path rebasing | All exact-head tests passed | Real Windows migration/path execution remains open |
| B1 explicit candidate review and exact accounting | Called packaged bulk reconciliation for an existing and missing item with online lookup disabled; full contract, desktop, TUI, and Rust tests exercise selective apply, identity, cancellation, covers, audit, and stale responses | Ordered outcomes accounted for both IDs as `no-candidates` and `missing` without mutation. All repository tests passed. | TUI bulk queue is an optional follow-up, not required by the completed selected-book workflow |
| B2 10,000-book query and facets | Ran both committed performance gates after the virtual-library implementation. The release-CLI benchmark also asserts 513 total matches and exactly 100 page items across text, author, tag, series, language, and format filters. | Reference-store p95 was 110.0 ms. Native release-CLI p95 was 64.18 ms after filtering in SQLite before hydration. Both passed the 150 ms product gate. | Structured grammar and richer reusable organization remain open |
| B2 persistent virtual libraries | Through both packaged executables, saved a virtual library, reopened it through a fresh process and the legacy alias, combined its base scope with session text/author filters, contradicted its tag with a session tag, requested a missing scope, and saved the same ID independently under two named-library selectors. Desktop state/DOM tests cover active-scope restoration and `All books` exit behavior; the desktop bundle was rebuilt and locally verified. | Both artifacts returned the same scoped book, zero items for the same-facet contradiction, `not-found` for the missing scope, and isolated Alpha/Beta definitions after relaunch. Every machine command emitted one JSON envelope with empty stderr. | Desktop has no named-library switch UI; TUI has no virtual-library surface. Structured grammar, custom columns, templates, and richer bulk organization remain open |
| C1 redacted support diagnostics | Called packaged `library diagnostics`; compared declared bytes and SHA-256 with the published file; inspected serialized content; repeated the same destination | Exact bytes and digest matched. Library root and title were absent. The second publication failed with `destination-exists`. | Durable operation audit records and broader queue/server/device summaries remain open |
| C1 reproducible native performance regression | Ran `test:performance:native:library` against 10,000 books and 15,000 formats through the release CLI; CI and release workflows invoke the same command | Three pre-fix runs reproduced p95 of 214-232 ms. Repeated optimized runs measured 55-60 ms, the definitive exact-head run measured 60.0 ms, and the committed gate now fails above 150 ms. Invalid benchmark mode fails immediately. | Import, merge, and server latency gates remain open |
| C2 transactional recovery | Exact-head tests cover import, duplicate merge, candidate cover publication, migration rollback, attachment races, backup, and portable publication failure paths | Full Rust suite passed after the public acceptance run | Exhaustive power-loss, disk-full, and user-facing recovery journeys remain open |
| D1 mounted-reader workflow | Created an isolated Kobo-shaped mount, called packaged `destination list`, `send`, and `destination inventory` | Device classified as Kobo, EPUB copied and hash-tracked, inventory returned `present` | This is a simulator, not real hardware. Stable identity across remounts and real Kobo/Kindle evidence remain open |
| D1 default Kobo delivery root | Initial public acceptance returned `invalid-arguments`; `f8e396a` corrected root publication and added unit plus public CLI regressions | Rebuilt standalone and sidecar packages both delivered successfully to the authorized mount root | Other platforms and real remount behavior remain open |
| D2 additional transports | Capabilities truthfully report current mounted destination and rooted-Kindle SSH support | No unsupported command is falsely advertised | Linux/Windows mass storage, MTP, wireless, and email are open |
| E1-E3 reading and editing | Launched each packaged binary in a 60x16 PTY and quit through the real TUI | Both exited 0, restored the alternate screen, and restored the cursor | Secure EPUB reading, progress, annotations, browser reuse, and editing remain open |
| F1-F2 automation and extensibility | Machine commands returned stable bounded envelopes; candidate reconciliation accounted for every ID | Current CLI/service primitives remain deterministic and scriptable | Recipe manifests, durable run ledger, resume, and extension boundary remain open |
| G1 authenticated local content service | Started packaged `serve` on loopback port 0; exercised health, catalog, book download, unauthorized access, and wrong method | Authenticated health and path-free catalog returned 200; exact EPUB bytes downloaded with attachment disposition; missing token returned 401; POST returned 405 | Lifecycle management, OPDS, covers, ranges, conditional requests, search, and stable links remain open |
| G2 remote multi-user service | Remote/TLS capability remains false and remote flags are rejected | Capability output is honest | TLS, users, revocation, scopes, rate limiting, audits, and browser reader remain open |
| H1 desktop accessibility and preferences | Full desktop test/build suite and packaged bundle verification passed; existing DOM tests cover focus, keyboard, live status, cancellation, and candidate workflows | Exact-head desktop package built successfully with the final Rust sidecar | Complete WCAG 2.2 AA workflow acceptance, durable preference model, localization, and pseudo-localization remain open |
| H2 distribution and support | Rebuilt standalone checksum artifact and macOS ARM64 desktop directory package; ran the bundle verifier | Standalone checksum passed. Bundle architecture and sidecar were valid. | Notarized distribution mode, macOS Intel, Linux/Windows desktop, updater, clean-install, rollback, and uninstall journeys remain open |

## Whole-program assessment

The result is concretely better than the pre-program baseline in library parity,
review-first metadata, recovery, deterministic automation primitives, local
content delivery, diagnostics, and regression detection. The public acceptance
run also found and fixed a real default Kobo delivery failure that the previous
aggregate test suites had missed.

The overall Calibre gaps 2 through 9 program remains active. Areas 5 and 6 are
mostly future product work, area 4 still lacks real-hardware and stable-identity
evidence, area 7 remains a narrow local service, area 9 remains macOS ARM64-only,
and B2 still lacks structured query grammar, custom organization columns and
templates, and richer reusable bulk organization. Virtual-library persistence
and scope composition now pass through both packaged Rust interfaces. The shipped
Rust query path still passes its 150 ms target at 64.18 ms p95 through the release
CLI boundary.
