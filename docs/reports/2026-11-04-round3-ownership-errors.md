# Round 3 ownership and error-boundary remediation

Date: November 4, 2026. Branch: `main`. Local commits only, no push.

All 45 assigned findings were verified against the original tree and addressed by root cause. No Desloppify command was run. Cargo operations used offline resolution and already cached crates. Tests used isolated temporary libraries, not real books or physical readers.

## Commits and acceptance evidence

- `a445b0f`: canonical domain imports, consistent `foo.rs` module roots, shortened domain filenames, CLI-owned shared envelopes, typed HTTP boundary codes, and the actual architecture map.
- `ed936c3`: typed import/Calibre/bulk-update/export/reconciliation outcomes, enum skip/duplicate reasons, and validated persisted conversion-job error codes.
- `c032af9`: operation-specific IO mapping retains redacted `io_kind()`, default IO conversion retains the existing `storage-unavailable` wire code, and redundant mappings are removed.
- `d6b9fd3`: workspace dependency inheritance, cached SHA-256 0.11.1 shared with lopdf, and remaining typed diagnostic/content-outcome serialization.

Each implementation commit passed `cargo fmt --all`, `cargo test --offline --workspace`, and `cargo clippy --offline --workspace --all-targets -- -D warnings` before committing. Initial compile failures during the SHA migration exposed the changed digest display API. All three affected expressions now use the existing `hex::encode` dependency, with hash vectors and export/inventory integration tests passing.

Final gates passed: `CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh` and a separate `bash scripts/test-release-scripts.sh`. The native gate verified adapter dependency isolation, formatting, strict workspace Clippy, workspace tests, the release build, bundle-verifier tests, and release-script tests. The release executable is 11,944,480 bytes, below the 12,000,000-byte budget. The report's 45 unique identifiers were checked against the supplied issue file, and every named Rust test was checked against the source tree.

### Compatibility and scope notes

- The missing-title import regression proves that an otherwise readable `.kepub.epub` source must report `invalid-title`, not the previous collapsed `unreadable`. The test checks the exact wire code and preservation of the source. Other error spellings remain serde-pinned.
- The blanket IO conversion deliberately retains `storage-unavailable` for compatibility, but no longer discards the IO kind. Explicit source, copy, publication, and destination mappings retain their established codes and IO kinds. Private paths and OS error text are not retained.
- `sha2` 0.11.1 was already in both the lockfile and offline registry. `cargo tree --offline -i sha2@0.11.1` shows lopdf, engine, and CLI test dependencies sharing it. `cargo tree --offline -i sha2@0.10.9` has no active macOS dependents. The lockfile retains 0.10.9 for external target-specific dependencies, not a remaining engine/lopdf split.
- Canonical-path changes are exercised by compiling all workspace callers and targets, not by retaining tests that pin deleted compatibility aliases. `architecture_documents_engine_module_owners` checks documented public engine module ownership against the source tree.
- Release/bundle tests do not establish physical Kindle compatibility, distribution notarization, or hardware delivery, and none is claimed.

## Per-identifier results

Each line gives status, implementation commit, and named acceptance tests. Workspace compilation and strict Clippy additionally cover every import/layout change.

- `format_moved_but_conversion_shim_still_used`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `conversion_profiles_keep_wire_names_and_reject_unknown_values`.
- `compat_reexports_keep_old_ownership`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `per_item_error_codes_keep_exact_wire_shapes` (extended in `ed936c3`).
- `formatid_compat_reexport_half_migrated`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `conversion_profiles_keep_wire_names_and_reject_unknown_values`.
- `conversion_format_reexport_used_internally`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `conversion_profiles_keep_wire_names_and_reject_unknown_values`.
- `formatid_routed_through_conversion`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `conversion_profiles_keep_wire_names_and_reject_unknown_values`.
- `apperror_two_import_paths`: fixed | `a445b0f` | `every_error_code_preserves_its_wire_string`, `failure_envelope_preserves_every_typed_wire_code`.
- `output_reexport_shim_dual_import_path`: fixed | `a445b0f` | `every_error_code_preserves_its_wire_string`, `failure_envelope_preserves_every_typed_wire_code`.
- `errors_imported_via_output_module`: fixed | `a445b0f` | `every_error_code_preserves_its_wire_string`, `failure_envelope_preserves_every_typed_wire_code`.
- `error_type_dual_import_path`: fixed | `a445b0f` | `every_error_code_preserves_its_wire_string`, `every_error_code_has_explicit_native_messages`.
- `compat_reexports_still_dominant`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `import_list_and_search_round_trip_through_the_binary`.
- `lib_rs_flattening_shim`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `import_list_and_search_round_trip_through_the_binary`.
- `cli_glob_reexports_engine_as_crate`: fixed | `a445b0f` | `import_list_and_search_round_trip_through_the_binary`, `jobs_commands_return_desktop_compatible_envelopes`.
- `triple_module_names`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `import_list_and_search_round_trip_through_the_binary`.
- `cli_glob_reexport_mixed_addressing`: fixed | `a445b0f` | `import_list_and_search_round_trip_through_the_binary`, `jobs_commands_return_desktop_compatible_envelopes`.
- `cli_glob_reexport_hides_engine_seam`: fixed | `a445b0f` | `import_list_and_search_round_trip_through_the_binary`, `jobs_commands_return_desktop_compatible_envelopes`.
- `desktop_engine_reexports_engine_types`: fixed | `a445b0f` | `every_error_code_has_explicit_native_messages`, native workspace state integration tests.
- `domain_folder_name_stutter`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, `portable_export_and_rebuild_preserve_rich_metadata_order_and_bytes`.
- `mixed_module_root_file_style`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`, native workspace state integration tests.
- `output_module_mixes_errors_and_cli_stdout`: fixed | `a445b0f` | `success_envelope_preserves_values_and_escapes_physical_newlines`, `failure_envelope_preserves_every_typed_wire_code`.
- `engine_owns_cli_stdout_protocol`: fixed | `a445b0f` | `success_envelope_preserves_values_and_escapes_physical_newlines`, `failure_envelope_preserves_every_typed_wire_code`.
- `cli_envelope_lives_in_engine_output`: fixed | `a445b0f` | `success_envelope_preserves_values_and_escapes_physical_newlines`, `failure_envelope_preserves_every_typed_wire_code`.
- `envelope_and_http_codes_duplicated`: fixed | `a445b0f` | `failure_envelope_preserves_every_typed_wire_code`, `catalog_http_boundary_authenticates_and_projects_rich_and_sparse_books`.
- `http_auth_error_codes_untyped_literals`: fixed | `a445b0f` | `catalog_http_boundary_authenticates_and_projects_rich_and_sparse_books`, `every_error_code_preserves_its_wire_string`.
- `string_error_comparisons_post_migration`: fixed | `ed936c3` | `typed_update_outcomes_keep_wire_shape`, `update_many_accounts_for_updated_and_missing_items`.
- `string_error_branching_after_typed_codes`: fixed | `ed936c3` | `typed_update_outcomes_keep_wire_shape`, `every_error_code_has_explicit_native_messages`.
- `code_string_equality_checks`: fixed | `ed936c3` | `typed_update_outcomes_keep_wire_shape`, `per_item_error_codes_keep_exact_wire_shapes`.
- `adapter_stringly_error_residue`: fixed | `ed936c3` | `typed_update_outcomes_keep_wire_shape`, `update_many_accounts_for_updated_and_missing_items`.
- `stringly_error_code_residue_after_typed_errorcode`: fixed | `ed936c3`, `d6b9fd3` | `per_item_error_codes_keep_exact_wire_shapes`, `catalog_saved_views_and_content_search_work_without_calibre`, `library_diagnostics_records_missing_library_without_creating_it`.
- `import_outcome_codes_stringly_and_collapsed`: fixed | `ed936c3` | `import_outcome_wire_codes_reasons_and_counts_are_stable`, `readable_import_with_empty_title_is_not_reported_as_unreadable`.
- `json_outcomes_tallied_by_status_string`: fixed | `ed936c3` | `typed_update_outcomes_keep_wire_shape`, `import_outcome_wire_codes_reasons_and_counts_are_stable`.
- `stringly_per_item_outcome_codes`: fixed | `ed936c3` | `per_item_error_codes_keep_exact_wire_shapes`, `import_outcome_wire_codes_reasons_and_counts_are_stable`.
- `calibre_import_handbuilt_outcome_json`: fixed | `ed936c3` | `calibre_import_preserves_metadata_formats_cover_duplicates_and_source_database`, `per_item_error_codes_keep_exact_wire_shapes`.
- `outcome_codes_bypass_errorcode`: fixed | `ed936c3` | `per_item_error_codes_keep_exact_wire_shapes`, `import_outcome_wire_codes_reasons_and_counts_are_stable`.
- `dead_cross_device_move_code`: fixed | `ed936c3` | `readable_import_with_empty_title_is_not_reported_as_unreadable`, `calibre_import_uses_stable_top_level_errors_without_writing_the_source`.
- `import_reason_string_matching`: fixed | `ed936c3` | `import_outcome_wire_codes_reasons_and_counts_are_stable`, `batch_import_reports_imported_and_skipped_files`.
- `calibre_import_untyped_value`: fixed | `ed936c3` | `calibre_import_preserves_metadata_formats_cover_duplicates_and_source_database`, `calibre_import_contains_malicious_paths_symlinks_and_custom_columns`.
- `job_error_codes_bypass_errorcode`: fixed | `ed936c3` | `persisted_error_codes_round_trip_and_unknown_codes_are_rejected`, `jobs_commands_return_desktop_compatible_envelopes`.
- `job_error_code_bypasses_errorcode_enum`: fixed | `ed936c3` | `persisted_error_codes_round_trip_and_unknown_codes_are_rejected`, `jobs_commands_return_desktop_compatible_envelopes`.
- `job_error_codes_untyped`: fixed | `ed936c3` | `persisted_error_codes_round_trip_and_unknown_codes_are_rejected`, `every_error_code_preserves_its_wire_string`.
- `blanket_io_into_storage_unavailable_drops_context`: fixed | `c032af9` | `io_errors_keep_redacted_kind_and_explicit_codes`, `portable_io_errors_preserve_kind_and_wire_code`, `staged_cover_io_errors_preserve_kind_and_wire_code`.
- `redundant_io_storage_map_err`: fixed | `c032af9` | `portable_io_errors_preserve_kind_and_wire_code`, `staged_cover_io_errors_preserve_kind_and_wire_code`.
- `sha2_version_split_with_lopdf`: fixed | `d6b9fd3` | `hashes_empty_input`, `hashes_known_vector`, `hashes_inputs_larger_than_one_chunk`, `export_many_organizes_every_format_and_uses_stable_collision_safe_names`, offline inverse dependency-tree checks.
- `no_workspace_dependency_table`: fixed | `d6b9fd3` | full offline workspace tests and all-target strict Clippy, native dependency-isolation gate.
- `architecture_module_map_stale`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`.
- `architecture_module_map_drifted_again`: fixed | `a445b0f` | `architecture_documents_engine_module_owners`.
