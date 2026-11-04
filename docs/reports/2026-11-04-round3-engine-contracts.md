# Round 3 engine contracts, November 4, 2026

Verified against `.desloppify/subagents/round3_issues.json`, without running Desloppify or using network access. All libraries and fake devices used by tests are temporary. No real books, devices, accounts, or remote Git branches were changed.

Validation: `cargo fmt --all`, `cargo test --offline --workspace`, and `cargo clippy --offline --workspace --all-targets -- -D warnings` passed in task `910179zmpd`. Engine unit results: 242 passed, 2 ignored; desktop: 243 passed. CLI, architecture, domain-wire, shared-domain and compile-fail doc tests passed. Existing ignored tests remain ignored. The dependency future-incompatibility notice for `block 0.1.6` is not a Clippy failure.

## Per-identifier outcomes

- `store_import_scan_cycle`: fixed | CODE_COMMIT | Source-overlap validation now lives in library paths; existing recursive import overlap and symlink safety tests pass.
- `store_remove_actually_trashes`: fixed | CODE_COMMIT | Removed misleading store `remove` alias; trash/purge safety tests and CLI integration tests pass. CLI `library remove` retains its historical `item`, `cleanupPending`, and `cleanupPendingPaths` JSON fields.
- `preflight_startup_unnamed_bool`: fixed | CODE_COMMIT | Renamed predicate to `requires_verified_migration`; recovery and native startup tests pass.
- `remove_view_option_never_none`: fixed | CODE_COMMIT | Returns `SavedView` directly, with not-found remaining an error; saved-view tests pass. Duplicate review occurrences were fixed once.
- `remove_and_trash_divergent_shapes`: fixed | CODE_COMMIT | One store trash operation returns `LibraryItem`; legacy CLI envelope is constructed at the adapter boundary. Store and CLI tests pass.
- `mixed_mutation_receivers`: fixed | CODE_COMMIT | Catalogue and job mutations require mutable receivers; read-only wrapper has no mutable dereference. Compile-fail read-only mutation test and workspace tests pass.
- `stray_copied_doc_line_replace_format`: fixed | CODE_COMMIT | Removed unrelated copied documentation above `replace_format`; formatting and strict Clippy pass.
- `legacy_author_scalar_never_backfilled`: not fixed | Legacy v4-to-v5 migration still creates structured authors without backfilling; scalar-only patches can still diverge. A transactional, idempotent migration plus write-side normalization and temporary-copy migration coverage remains required. No migration was attempted in this slice.
- `cover_mutators_bypass_mutation_result_cleanup_contract`: fixed | CODE_COMMIT | Cover replacement/removal return `MutationResult`; forced orphan-cleanup failures preserve committed catalogue state and report paths in `cover_mutations_report_preserved_orphans_after_commit`.
- `stored_row_validation_error_code_diverges`: fixed | CODE_COMMIT | Invalid stored custom-column definitions consistently report invalid-stored-data; column corruption tests pass.
- `saved_view_mutators_take_shared_receiver`: fixed | CODE_COMMIT | Save/remove view require `&mut self`; shared read-only handle cannot invoke them. Saved-view and compile-fail tests pass.
- `query_field_list_duplicated_behind_unreachable`: fixed | CODE_COMMIT | Parsed query fields use an enum, with exhaustive SQL matching rather than repeated string lists and unreachable fallback; structured-query and query-cache tests pass.
- `provenance_hand_parsed`: fixed | CODE_COMMIT | Canonical `Provenance::from_str` is reused by hydration, format reads and duplicate scanning; unknown stored provenance regression test passes.
- `library_query_filters_mirror_type`: fixed | CODE_COMMIT | Query request and store borrow the same owned `Filters` domain type; duplicate borrowed mirror and conversion removed. Query-cache parity, CLI shared-domain and desktop tests pass.
- `prepare_and_attach_workflow_owned_by_frontends`: fixed | CODE_COMMIT | Reviewed preparation moved into engine `conversion::prepare`; job attachment policy moved into `JobStore::reconcile_attachment`. Engine fake-converter preparation tests, native worker integration and CLI attachment tests pass.
- `text_extractable_formats_triplicated`: fixed | CODE_COMMIT | `FormatId::is_text_extractable` supplies one exhaustive capability predicate to maintenance and both CLI workflows; workspace tests and exhaustive compilation pass.
- `regex_recompiled_for_trivial_patterns`: fixed | CODE_COMMIT | Date, language and filename normalization expressions use `LazyLock`; existing metadata normalization tests pass.
- `device_hash_failure_reported_as_source_unavailable`: fixed | CODE_COMMIT | Reader hash errors carry destination/copy context rather than source-unavailable; destination error-code and reader inventory tests pass.
- `manifest_read_failures_reported_as_copy_failed`: fixed | CODE_COMMIT | Manifest IO errors are destination-unavailable, malformed/version-invalid manifests invalid-stored-data, absent removal records not-found. Regression tests cover these distinctions and preservation after manifest failure.
- `reader_shelf_uncounted_read_failures`: fixed | CODE_COMMIT | Metadata/hash failures and changed-byte-count hashing increment unreadable rather than yielding unmatched import candidates; injected hash-failure regression passes.
- `sibling_param_order_swaps`: fixed | CODE_COMMIT | Public SSH send now follows destination/item/source ordering, and reconciliation metadata arguments align with the cancellable sibling. Workspace compilation, fake SSH and reconciliation tests pass.
- `destinations_send_public_seven_args`: fixed | CODE_COMMIT | Low-level seven-argument copy routine is crate-private; reviewed engine delivery remains the public entry point. Delivery planning and copy tests pass.
- `subprocess_poll_pipe_and_reap_gaps`: fixed | CODE_COMMIT | SSH capture uses a temporary file rather than undrained pipes, bounds captured reads, and kills/reaps on timeout/poll errors; converter polling also kills/reaps on errors. Fake executable tests cover large output and timeout. The file can grow between polling intervals; this does not claim process-tree containment or physical Kindle compatibility.
- `constant_regex_error_branches`: fixed | CODE_COMMIT | SSH constant expressions initialize once and treat invalid patterns as programmer invariants, not user argument failures. Validation and fake SSH tests pass.
- `dual_pdf_parsing_stacks`: not fixed | Preserved the bounded heuristic because `counts_pdf_pages_from_raw_bytes` explicitly accepts incomplete raw-page, linearized `/N`, and compressed ObjStm fragments without complete PDF structure. Replacing it with strict lopdf loading would change fixture behavior and import skip decisions. Existing tests pass; no claim of parser equivalence or unchanged lopdf allocation bounds is made.
- `candidate_cover_positional_str_quad`: fixed | CODE_COMMIT | Public stage/validate/claim take named `CoverBinding` identity fields; cover ownership, concurrency and staging tests plus all adapters compile and pass.
- `duplicate_write_new_helpers`: fixed | CODE_COMMIT | Candidate cover and portable output reuse the same create-new/write/sync helper in fingerprint; collision, portable rebuild and cover tests pass.
- `library_metadata_import_reciprocal_edges`: not fixed | Partial improvement only: import validation moved into paths, and item-ID validation already has a canonical store module. Embedded metadata and store-consuming metadata workflows still share a folder; the remaining layering split was not performed.
- `export_sanitizer_edge_cases_untested`: fixed | CODE_COMMIT | Added punctuation/control-only fallback, normalization, long author, multibyte truncation and identity-suffix filename tests; export suite passes.
- `custom_column_type_string`: fixed | CODE_COMMIT | Closed `CustomColumnType::Text` replaces the unchecked string, preserving lowercase wire format; unknown JSON and corrupt SQLite type regression tests pass.

## Remaining acceptance limits

Twenty-seven identifiers are addressed, three are explicitly unresolved above. File-backed subprocess capture is polling-bounded, not a strict disk-allocation limit. Fake SSH/converter and simulated mounted destinations do not establish compatibility with physical readers. The metadata author migration and metadata folder split need follow-up rather than being silently treated as completed.
