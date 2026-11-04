# Round 3 CLI adapter review fixes

All fixtures use temporary libraries. Work stayed offline and local, with no Desloppify run or push. Engine fixture additions, example/test moves, and the integrity serializer visibility change were explicitly approved by the engine-contracts owner. The engine API and CLI adapter changes are committed together so neither side leaves a broken workspace.

- `duplicated_signal_hook_plumbing`: fixed | COMMIT_PENDING | Existing RAII `CancellationSignals` replaces CLI signal-hook registration/thread cleanup, direct dependency removed. CLI watch signal and multi-cycle regressions.
- `service_request_partial_helper_adoption`: fixed | COMMIT_PENDING | All duplicate service requests use `decode_request`; shared `encode_response` covers service result serialization. Typed service and custom-column integration tests.
- `cli_integrity_value_copy`: fixed | COMMIT_PENDING | CLI uses engine `diagnostics::integrity_value`; CLI verification/backup and engine diagnostics tests.
- `cli_signal_test_timing_race`: fixed | COMMIT_PENDING | Real subprocess waits for a completed-cycle NDJSON progress event before SIGTERM, asserts exact count, and bounds readiness/shutdown. No fixed startup sleep or import-throughput assumption.
- `cli_watch_test_polls_internal_table`: fixed | COMMIT_PENDING | Between-cycle source replacement is deterministic through the real watch loop's callback; public store results verify preservation. Restart observation coverage uses CLI counts, not engine tables.
- `cli_tests_mutate_engine_schema`: fixed | COMMIT_PENDING | Feature-gated engine fixture helpers own corruption, private audit, and legacy schema setup. Corrupt hydration, catalogue privacy, custom-field read-only bytes, and non-migration CLI tests.
- `service_destructive_commands_skip_strict_decode`: fixed | COMMIT_PENDING | Strict trash/restore/purge, update, format removal, and cover envelopes reject typo fields without changing active or trashed books/files. Invalid destructive requests also cannot create a missing library.
- `cli_duplicates_engine_import_guard`: fixed | COMMIT_PENDING | Retains pre-open overlap guard and removes post-open/per-cycle duplicate calls. Engine scan remains authoritative; pre-open overlap and deterministic between-cycle symlink tests.
- `cli_service_bypasses_decode_request`: fixed | COMMIT_PENDING | Four duplicate-request arms now use the shared decoder. Service unknown-field and duplicate CLI regressions.
- `engine_examples_and_tests_in_cli_crate`: fixed | COMMIT_PENDING | Three examples and the engine-only metadata candidate test moved into the engine crate. CLI PDF tests use `test_support::pdf`. Offline example build and workspace test inventory check.
- `cli_batch_validation_duplicated`: fixed | COMMIT_PENDING | Shared batch bound and selection validation, typed Clap import modes. Boundary/duplicate/blank selection and accepted/rejected mode parser regression, CLI import tests.
- `server_serves_trashed_books_by_id`: fixed | COMMIT_PENDING | Real ephemeral loopback regression first failed with HTTP 200; both item and format routes now return 404 for trashed books using `get_active`. Authenticated HTTP regression passes.
- `tui_disconnect_empty_id_sentinel`: fixed | COMMIT_PENDING | Dedicated disconnected-loader branch clears receiver/cancellation/loading and reports failure without inventing an item ID. Disconnected and stale-result TUI regressions.

## Validation

Passed on November 4, 2026:

- `cargo fmt --all`
- `cargo test --offline --workspace`: 630 passed, 3 intentionally ignored, no failures, including compile-fail documentation checks.
- `cargo clippy --offline --workspace --all-targets -- -D warnings`
- `cargo build --offline --workspace --examples`
- `cargo test --offline --workspace -- --list`: 633 tests after relocation versus 628 before. The difference is five added safety regressions across the concurrent lanes. The engine-only metadata test remains present exactly once, and all 12 preparation tests moved from desktop to engine retain their cases under the new module prefix. No tests were lost in the moves.

The ignored cases are the independent Poppler oracle and two opt-in release benchmarks. The dependency `block 0.1.6` emits an existing future-incompatibility advisory, not a failed strict-Clippy check. Earlier gate attempts hit in-flight changes from the concurrent engine/desktop lanes; the final coordinated tree passed all gates.
