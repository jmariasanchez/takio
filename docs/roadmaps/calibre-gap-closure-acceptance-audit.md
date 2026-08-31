# Calibre Gap Closure Whole-Program Acceptance Audit

Date: 2026-08-31

Accepted implementation head: `2b33b74`

This audit closes the feedback loop over the work completed so far. It does not
claim that Calibre gaps 2 through 9 are complete. It separates observed public
behavior from automated regression evidence and from requirements that remain
open or externally blocked.

## Acceptance paths exercised

Two independently packaged Rust executables completed the same public workflow:

- Standalone release: `dist/releases/takio-v0.1.0-macos-arm64`
  - SHA-256: `4c446423b134aef9b39393b17afc4247a3cad6bbfded0f532410212605bea9bb`
- Desktop sidecar:
  `apps/desktop/release/mac-arm64/Takio.app/Contents/Resources/bin/takio-library-engine`
  - SHA-256: `28fac132be49181a47be94edbb1b89de1da1a9bdec5ba60c427f34b8ebf5a94d`

The whole-program acceptance harness is retained outside the repository at
`$JCODE_SCRATCH_DIR/takio-program-acceptance.py`. The additional structured-query
acceptance harness is retained at
`$JCODE_SCRATCH_DIR/takio-structured-public-accept.py`. Organized export acceptance
is retained at `$JCODE_SCRATCH_DIR/takio-export-public-accept.py`. Bounded custom
field acceptance is retained at
`$JCODE_SCRATCH_DIR/takio-custom-fields-public-accept.py`, and library-defined
text-column acceptance is retained at
`$JCODE_SCRATCH_DIR/takio-text-columns-public-accept.py`. They create
isolated data, but all application behavior crosses the real packaged CLI,
desktop sidecar, foreground HTTP server, filesystem, SQLite,
mounted-destination, or PTY interfaces as applicable. They do not call Rust
internals or copy application source.

Both artifacts reported:

- `implementation: rust`
- library schema version 12
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
| A2 backup and recovery | Called packaged `library backup`, `library restore-backup`, and `library verify` | Restored schema 12 contained two active books and two verified managed formats | Large-library retry-memory and soak evidence remain open |
| A2 Calibre import, watch, and schema migration | Exact-head Rust integration suite exercises frozen Calibre input, live WAL, restart accounting, signal cancellation, v1-v11 migration, backups, rollback, spoofed schemas, and path rebasing | All exact-head tests passed | Real Windows migration/path execution remains open |
| B1 explicit candidate review and exact accounting | Called packaged bulk reconciliation for an existing and missing item with online lookup disabled; full contract, desktop, TUI, and Rust tests exercise selective apply, identity, cancellation, covers, audit, and stale responses | Ordered outcomes accounted for both IDs as `no-candidates` and `missing` without mutation. All repository tests passed. | TUI bulk queue is an optional follow-up, not required by the completed selected-book workflow |
| B2 10,000-book query and facets | Ran the reference performance gate and the combined literal/structured native gate through both packaged Rust executables. The fixture contains 10,000 books and 15,000 formats, and the native gate asserts 513 total matches and exactly 100 page items across query, facet, sorting, paging, hydration, and JSON boundaries. | Reference-store p95 was 110.0 ms. The exact-head packaged standalone p95 was 62.64 ms and desktop sidecar p95 was 69.48 ms. Structured-only p95 was 53.72 ms and 69.48 ms. Every path passed the 150 ms product gate. | Larger production-library soak and mutation throughput gates remain open |
| B2 persistent virtual libraries | Through both packaged executables, saved a virtual library, reopened it through a fresh process and the legacy alias, combined its base scope with session text/author filters, contradicted its tag with a session tag, requested a missing scope, and saved the same ID independently under two named-library selectors. Desktop state/DOM tests cover active-scope restoration and `All books` exit behavior; the desktop bundle was rebuilt and locally verified. | Both artifacts returned the same scoped book, zero items for the same-facet contradiction, `not-found` for the missing scope, and isolated Alpha/Beta definitions after relaunch. Every machine command emitted one JSON envelope with empty stderr. | Desktop has no named-library switch UI; TUI has no virtual-library surface. Arbitrary template grammar and richer bulk organization remain open |
| B2 bounded structured queries | Through both packaged executables, created real managed books and metadata in SQLite, then queried title, author, tag, series, publisher, language, format, identifier, description, and safe `#key` custom text fields. The workflow also exercised quoting, implicit conjunction, `not`, literal-default compatibility, structured virtual-library composition, malformed saved definitions, unknown fields/operators, reserved custom keys, null and unknown syntax values, and non-persistence after rejection. Desktop contract, reducer, DOM, type, build, package, and bundle checks covered the explicit Literal/Structured selector and guidance. | Both artifacts returned the same expected book for every fixed field and custom text key, preserved literal behavior, composed the persisted scope correctly, rejected malformed or reserved grammar as `invalid-query`, rejected invalid syntax values as `invalid-arguments`, kept rejected state absent, and emitted one JSON envelope with empty stderr. | This is a deliberately bounded Calibre-style subset. OR, parentheses, regex, comparisons, dates/numbers, library-defined column labels, custom sort/facets, and TUI structured search remain open |
| B2 bounded custom text fields | Through both exact-head packaged executables, imported and edited real books, created a durable candidate audit, replaced user custom fields, searched keys and values literally and with `#shelf`, negated and composed the field with a virtual library, attempted reserved-key forgery, exported JSON and CSV catalogues, queried `/v1/books`, `/v1/catalog`, and `/v1/books/:id`, portably exported and rebuilt the library, and rebuilt a manifest-valid OPF containing a forged reserved key. Desktop focused and full real-DOM suites exercised ordered rows, keep/replace/clear, validation, accessible errors, inspector rendering, and structured guidance. | User fields remained editable and queryable. The exact audit survived ordinary replacement, forgery returned `invalid-arguments`, JSON/CSV/HTTP retained user fields while omitting audit data, portable rebuild retained user fields while omitting the audit, and the forged OPF returned `source-invalid` before destination creation. Both binaries emitted one JSON envelope with empty stderr. | Undeclared legacy fields remain supported as text metadata but do not gain definition labels, sorting, or facets. |
| B2 library-defined text columns | Through both exact-head packaged executables, created, listed, renamed, reopened, and removed a definition while preserving per-book values; migrated a real v11 library into v12 with a verified backup; imported a real-shaped Calibre custom-column definition and value; round-tripped portable v2 definitions and values; accepted portable v1; rejected a padded label; and exercised correlated service requests. A Bun-created schema-v12 library containing a definition was then verified by both packaged Rust executables. Desktop tests exercised labeled editing, legacy-field retention, the session-only table column, and stale-library refresh cleanup. | Both artifacts returned identical CRUD, migration, Calibre, portable, and service results with one JSON envelope and empty stderr. Rust and Bun now create the same canonical v12 cleanup, duplicate-review, import-watch, and definition schema. Contract and Bun regressions also prove canonical UTF-8 ordering for non-BMP duplicate IDs. | The delivered type is single-valued text. Typed/multi-valued/computed columns, custom sorting/facets, persistent table preferences, and bulk delta edits remain open |
| B2 bounded save-to-disk organization | Through both exact-head packaged executables, imported three real books including a multi-format item and same-title collision, applied long Unicode and unsafe path characters, then called `library export-many` with `flat`, `author`, and `series` presets. The harness checked every per-format outcome, exact bytes and SHA-256, full item-identity suffixes, 240-byte filename bounds, `Unknown author` and `Unsorted` fallbacks, author-title naming, repeat collision behavior, arbitrary-template rejection, duplicate-ID and unknown-field rejection before destination creation, and a symlinked organization directory. Desktop SSR and real-DOM tests exercised all controls and the exact submitted layout; the packaged bundle was locally verified. | Both artifacts exported four distinct formats with exact bytes, stable collision-safe names, and correct folder presets. Repeated export skipped all four without changing bytes. Invalid requests returned `invalid-arguments` with no destination side effect. The symlink case returned one `destination-unavailable` outcome per format and wrote nothing outside the selected root. Every command emitted one JSON envelope with empty stderr. | Arbitrary user-authored save-to-disk expressions, nested reusable grouping rules, and TUI export controls remain open |
| C1 redacted support diagnostics | Called packaged `library diagnostics`; compared declared bytes and SHA-256 with the published file; inspected serialized content; repeated the same destination | Exact bytes and digest matched. Library root and title were absent. The second publication failed with `destination-exists`. | Durable operation audit records and broader queue/server/device summaries remain open |
| C1 reproducible native performance regression | Ran `test:performance:native:library` against 10,000 books and 15,000 formats through both exact-head packaged executables; CI and release workflows invoke the same command | Three pre-fix runs reproduced p95 of 214-232 ms. The current standalone and sidecar runs measured 62.64 ms and 69.48 ms p95, and the committed gate fails above 150 ms. Invalid benchmark mode fails immediately. | Import, merge, and server latency gates remain open |
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
evidence, area 7 remains a narrow local service, and area 9 remains macOS
ARM64-only. B2 now has persistent virtual-library composition, a bounded
structured grammar, library-defined single-valued text columns, and collision-safe
every-format disk export with fixed flat, author, and series organization across
the shared contract, packaged Rust interfaces, Bun/Rust schema interoperability,
desktop controls, public catalogue boundaries, Calibre import, portable
interchange, and the 10,000-book performance gate. It still lacks typed or
multi-valued custom columns, custom sorting/facets, persistent column preferences,
bulk delta edits, arbitrary template grammar, and richer reusable bulk
organization. The exact-head packaged standalone and desktop-sidecar query paths
passed the 150 ms target at 62.64 ms and 69.48 ms p95 respectively.
