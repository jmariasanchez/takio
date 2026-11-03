# CLI review remediation, November 3, 2026

## Scope and reproducible checks

This local-only slice addresses the assigned CLI/device/dependency/documentation
blind-review findings. Tests use temporary libraries and fake executables only.
No network, physical reader writes, publishing, or dependency downloads are part
of this work. Fake SSH/SCP protocol tests do not prove Kindle compatibility.

- SSH transport/authentication failures must not claim a destination collision.
  Run `cargo test --offline -p takio kindle_ssh::tests`. Fake executables exercise
  root and absence probes, upload, exact SHA-256 verification, size fallback,
  mismatch rejection, no-overwrite publication races, transport failures,
  timeout cleanup, and preservation of existing destination bytes.
- Dependency cleanup removes unused direct `anyhow`/desktop `serde`, uses the
  cached Ratatui-compatible Crossterm 0.28, and replaces `fs2` with standard
  file locks. `candidate_cover::tests::concurrent_staging_never_exceeds_count_quota`
  retains the concurrency acceptance check.
- Absolute paths have one standard-library implementation with explicit
  `invalid-arguments` for empty paths. Existing path tests plus
  `empty_catalog_output_is_rejected_without_writing` cover the contract.
- Backend discovery has one environment/PATH/bundle resolver and canonicalizes
  before process working-directory changes. Invalid explicit overrides remain
  authoritative and unavailable, rather than selecting an unreviewed fallback.
- Query, column, and format-source requests use typed deserialization. Tests
  reject unknown, missing, null, and incorrectly typed fields and enforce query
  bounds. Saved-view scope composition and format snapshot tests remain gates.
- Candidate discovery always uses cancellable extraction, requires its library
  root, and shares cover staging. Existing cover, cancellation, and reconciliation
  integration tests cover retained behavior.
- Export outcomes reuse identity fields and count typed branches. Reader shelves
  compute final counters before construction. Existing export and KOReader shelf
  tests verify outputs without physical devices.
- CLI and native callers share the desktop preference-location resolver, including
  explicit profile precedence and suppression by a data-directory override.
- Contributor commands, the architecture module map, security boundaries, and
  service help now describe the native application and automation protocol.
  Historical Electron-specific custom-column acceptance is labeled historical.

## Coordinated store integration

The store worker introduced typed committed-mutation cleanup results and explicit
import outcomes. Its primary mutation APIs retain those results in `8771275`.
CLI add/import now exposes `status` and `sourcePreserved` while retaining `item`.
Remove, purge, and format mutations serialize the primary typed result directly,
including `cleanupPending` and `cleanupPendingPaths`. `library remove` moves to
recoverable Trash. Its help and test now verify preservation and restoration
rather than permanent deletion.
New CLI tests exercise duplicate move-source preservation and changed-file
cleanup reporting.

## Per-identifier report

All implementation commits are local on `main`, with nothing pushed.

| Identifier | Status and commit | Regression evidence |
| --- | --- | --- |
| `ssh_transport_failure_as_file_exists` | Fixed, `9a625f7` | `fake_ssh_failures_preserve_existing_files_and_clean_partial` checks root, preflight, hash and publish transport failures, timeouts, and genuine collisions. |
| `kindle_ssh_publish_protocol_untested` | Fixed, `9a625f7` | `fake_ssh_publishes_verified_bytes_and_cleans_partial` and `fake_ssh_failures_preserve_existing_files_and_clean_partial`, using temporary fake SSH/SCP executables only. |
| `unused_anyhow_cli` | Fixed, `c2faa03` | Removed direct manifest and lockfile edge, no CLI source uses it, full offline CLI/workspace tests and strict Clippy pass. |
| `unused_serde_desktop` | Fixed, `c2faa03` | Removed direct manifest and lockfile edge, no native source uses its derives, full offline workspace tests and strict Clippy pass. |
| `crossterm_version_skew_with_ratatui` | Fixed, `c2faa03` | `cargo tree --offline -p takio -i crossterm` shows one 0.28.1 used by Takio and Ratatui; all `tui::tests` pass. |
| `fs2_unmaintained_single_use` | Fixed, `c2faa03` | `concurrent_staging_never_exceeds_count_quota`, `claimed_cover_cannot_be_replayed_and_can_be_restored_or_consumed`, and the full cover suite pass using standard file locks. |
| `triplicated_absolute_path_helper` | Fixed, `ee7476d` | `rejects_conflicting_selectors_and_empty_database`, `relative_paths_are_absolute_but_not_canonicalized`, `empty_catalog_output_is_rejected_without_writing`, and portable export/rebuild tests. |
| `export_outcome_json_rebuilt` | Fixed, `ee7476d` | `export_many_organizes_every_format_and_uses_stable_collision_safe_names` and `export_many_rejects_symlinked_organization_directories`. |
| `hand_parsed_service_and_query_json` | Fixed, `ee7476d` | `typed_query_rejects_unknown_missing_null_and_out_of_range_fields`, `typed_service_arguments_reject_unknown_fields_without_mutation`, `format_replace_honors_the_expected_snapshot`, and existing virtual-library query tests. |
| `candidate_discovery_bool_policy` | Fixed, `ee7476d` | `metadata_candidates_reconcile_cancels_reaps_and_stops_later_stages`, `metadata_candidates_reconcile_reports_attempted_backend_failures_without_mutation`, and `embedded_candidate_cover_is_path_free_and_applies_with_bounded_audit`. |
| `reader_shelf_post_construct_mutation` | Fixed, `ee7476d` | `koreader_shelf_reports_reading_state_and_stock_kindle_does_not` plus the complete reader-shelf suite. |
| `forwarder_docstring_bloat` | Fixed, `ee7476d` | Source diff inspection, `hash_file_matches_reader`, `machine_commands_emit_one_record_and_matching_exit_status`, and formatting. |
| `cli_hardcodes_desktop_preference_layout` | Fixed, `ee7476d` plus native delegation in `e43c3e6` | `desktop_preference_respects_data_and_profile_overrides`, `human_list_says_when_the_desktop_app_uses_another_library`, and native `location_precedence_is_pure`. |
| `cli_rederives_desktop_preference_env` | Fixed, `ee7476d` plus native delegation in `e43c3e6` | Same tests. Both callers now share data-override suppression and explicit profile precedence. |
| `dual_backend_env_discovery` | Fixed, `c2faa03` | `canonical_discovery_preserves_override_path_bundle_precedence`, `relative_override_executes_reviewed_cwd_candidate_not_path_candidate`, `empty_path_component_is_pinned_to_reviewed_absolute_executable`, and shared discovery tests. |
| `architecture_doc_module_map_stale` | Fixed, `ee7476d` | Checked every module declaration in `lib.rs` against the architecture table; corrected CLI responsibilities. Historical document paths were retained to avoid breaking links. |
| `contributing_lists_removed_desktop_package` | Fixed, `ee7476d` | Removed stale duplicated script bodies, checked maintained commands against `package.json` and `scripts/check-rust-workspace.sh`. |
| `security_md_describes_electron_boundary` | Fixed, `ee7476d` | Source inspection against native engine threading, explicit path/device workflows, and absence of the removed renderer boundary. |
| `service_command_help_mentions_desktop_sidecar` | Fixed, `ee7476d` | `service_help_describes_automation_not_desktop`; historical Electron custom-column spec slice is explicitly labeled historical. |

No assigned findings were dismissed. Physical Kindle compatibility remains
unverified by this work. Existing ignored opt-in tests and the transitive
future-incompatibility notice described below are not claimed as resolved.

## Gates

Required before each commit: `cargo fmt --all`, `cargo test --offline -p takio`,
and `cargo clippy --offline --workspace --all-targets -- -D warnings`.
Dependency changes additionally require `cargo test --offline --workspace`.
Initial attempts exposed concurrent store changes and a load-sensitive fake SSH
fixture deadline. Success fixtures now allow ten seconds per command while
explicit timeout cases retain the one-second deadline. All four gates passed on
November 3 after those corrections. The full workspace run included 241 native
unit tests and two native integration tests. Three existing CLI tests remain
ignored because they require opt-in performance or independent PDF-oracle checks.
No new ignored tests were added. `cargo tree --offline -p takio -i crossterm`
confirmed one Crossterm 0.28.1 shared with Ratatui. A module-inventory check found
an architecture-table entry for every declared engine module. Strict Clippy
passed, with Cargo's existing future-incompatibility notice for transitive
`block 0.1.6` still present.

At the 22:08 UTC integration checkpoint, the post-`8771275` CLI tests and strict
workspace Clippy passed. An additional full workspace run then reached a newly
changed native suite with 242 passing tests and one failure:
`state::tests::automatic_backup_state_defers_for_edits_reviews_busy_loading_and_switch`
asserted `last_attempt.is_none()` at `automatic_backup_state_tests.rs:118`.
The same failure reproduced in isolation at 22:09 UTC. The native owner and
coordinator were notified. That ongoing native slice is outside this worker's
file ownership and does not replace the earlier passing dependency workspace
gate. It must be rerun after the native owner completes the concurrent changes.
