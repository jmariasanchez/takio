# Round 3 desktop polish, November 4, 2026

Local-only work on `main`, with offline Cargo commands and isolated temporary libraries. No Desloppify invocation, push, real-library mutation, or physical reader write was performed.

## Acceptance evidence

- `891e1f1`: startup regression failed before implementation with `StorageUnavailable`, then passed. `cargo fmt --all`, `cargo test --offline -p takio-desktop` (252 unit tests plus 2 process tests), and strict workspace/all-targets Clippy passed.
- `84e0af0`: native tests (255 unit tests plus 2 process tests) and strict workspace/all-targets Clippy passed. The real palette and metadata editor each blocked every registered global command. Input composition, accessibility metadata, keyboard workflows, and appearance initialization remained covered.
- Shared settings IO preserves bounded reads, reserved-entry rejection, atomic replacement, and caller-controlled parent creation. This does not claim protection against hostile concurrent ancestor replacement.
- Native test windows do not expose platform appearance-event injection. Initial theme installation is tested without a workspace, while live appearance follows the window observer. Physical display and VoiceOver behavior are not claimed.

## Per-identifier results

- `preparation_workflow_in_desktop_adapter`: not fixed | pending coordinated engine extraction validation.
- `can_close_predicate_mutates_status`: fixed | 891e1f1 | native close guards and workspace Clippy.
- `can_close_predicate_has_side_effects`: fixed | 891e1f1 | native close guards and workspace Clippy.
- `devices_destinations_readers_drift`: not fixed | reader terminology slice awaiting final validation.
- `image_features_rely_on_unification`: fixed | 891e1f1 | offline native cover codec tests, explicit jpeg/png/webp/gif/bmp/tiff features.
- `triplicated_ancestor_path_resolver`: not fixed | awaiting shared engine resolver.
- `engine_preparation_test_seam_branching`: not fixed | awaiting shared preparation API.
- `reader_destination_rule_repeated`: not fixed | awaiting shared reader classification API.
- `section_fetch_asymmetric_replies`: not fixed | pending typed reply consolidation.
- `preparation_timeout_scattered`: not fixed | awaiting shared preparation timeout.
- `preparation_timeout_literal_duplicated`: not fixed | awaiting shared preparation timeout.
- `open_verb_semantics_diverge`: not fixed | explicit create-or-migrate rename awaiting coordinated validation.
- `desktop_root_mixed_concerns`: not fixed | startup cluster grouping pending.
- `stale_preference_location_shim`: fixed | 891e1f1 | native preference precedence and startup tests.
- `desktop_launch_env_scattered`: not fixed | awaiting shared launch capture API.
- `theme_global_bootstrap_triplicated`: fixed | 84e0af0 | window theme installation without workspace, native suite, strict Clippy.
- `command_metadata_three_tables`: fixed | 84e0af0 | 31-command menu/palette/binding consistency test and native action workflows.
- `modal_action_denylists_diverge`: fixed | 84e0af0 | both_modals_block_every_global_command exercises both real modal dispatch trees.
- `search_is_generic_text_input`: fixed | 84e0af0 | TextInput UTF-16 composition, accessibility, keyboard, editor, palette and search integration tests.
- `settings_file_io_duplicated`: fixed | 891e1f1 | preference and automatic-backup bounded/unsafe-path/atomic persistence tests.
- `sidebar_monolithic_render`: not fixed | decomposition pending.
- `list_workspace_redundant_handlers`: fixed | 84e0af0 | native list/workspace keyboard workflows and full native suite.
- `check_then_take_activity_unreachable`: not fixed | safe activity extraction awaiting validation.
- `startup_fallback_hard_fails_on_unresolvable_saved_root`: fixed | 891e1f1 | red-green unresolvable saved-root regression, existing same-root and alias safeguards.
- `state_deref_plus_forwarding_getters`: not fixed | direct read-only session field access awaiting validation.
- `preparation_backend_wrapper_pair`: not fixed | awaiting shared preparation API.

## Follow-up

The results below supersede the pending entries above. Each new code slice passed
`cargo fmt --all`, `cargo test --offline --workspace`, and
`cargo clippy --offline --workspace --all-targets -- -D warnings` before its
commit. These are the "workspace gates" below. Tests used isolated temporary
libraries. Previously completed fixes were inspected against the current code
and exercised again, rather than rewritten unnecessarily.

- `preparation_timeout_scattered`: fixed | 586803a | workspace gates, shared public timeout used by the worker and both duration messages, converter timeout/source-preservation tests.
- `preparation_timeout_literal_duplicated`: fixed | 586803a | workspace gates, both state messages derive seconds from `PREPARATION_TIMEOUT.as_secs()`.
- `engine_preparation_test_seam_branching`: fixed | ca029d0 | workspace gates, backend resolved once on worker startup, native injected-backend preview/explicit-preparation regression.
- `preparation_backend_wrapper_pair`: fixed | ca029d0 | workspace gates, unused discovery wrappers removed and both requests always use the shared backend-taking functions.
- `reader_destination_rule_repeated`: fixed | ce6d09b | workspace gates, `reader_classification_depends_only_on_kind` covers Kindle, Kobo, generic and generic-with-KOReader, reader scan and delivery tests.
- `triplicated_ancestor_path_resolver`: fixed | 85dcd65 | workspace gates, shared resolver used by import overlap, Calibre import, store recovery and desktop startup, missing-leaf/symlink/parent-component/dangling-link/non-directory regression.
- `check_then_take_activity_unreachable`: fixed | 8a8bc7e (already present) | workspace gates, both activity helpers use one pattern-matching take and restore unmatched variants, exclusive-activity and repeated-confirmation tests pass. The remaining engine `unreachable!` is a test fixture string match, not activity extraction.
- `state_deref_plus_forwarding_getters`: fixed | b70d388 | workspace gates and snapshot-feature check, removed `Deref`, views and harnesses use the explicit read-only `session()` getter.
- `section_fetch_asymmetric_replies`: fixed | 4aa1a06 | workspace gates, existing shared reply shape and `request_section` dispatch retained, new native regression drops replies for both sections and verifies the same error and cleared loading state.
- `desktop_launch_env_scattered`: fixed | c0a7f1c | workspace gates and snapshot-feature check, single launch capture reused by normal/benchmark/snapshot entry points, shared engine constants used by CLI and process tests, capture-once and preference-isolation tests.
- `devices_destinations_readers_drift`: fixed | ada2530 | workspace gates, registry/menu/palette/status terminology regression and remaining spec wording aligned to "reader". Filesystem backup destinations retain their distinct meaning.
- `sidebar_monolithic_render`: fixed | 8a8bc7e (already present) | workspace gates, inspected `render_sections`, `render_readers`, `render_reader`, `render_facets` and shared `small_action`, native sidebar/accessibility/send/import workflows pass.
- `open_verb_semantics_diverge`: fixed | 8a8bc7e (already present) | workspace gates, desktop constructor is `Engine::create_or_migrate`, no `Engine::open` call sites remain, existing-only and startup recovery tests pass.
- `desktop_root_mixed_concerns`: fixed | af2ec7b | workspace gates and snapshot-feature check, startup/settings files and their tests moved with `git mv`, main/bench/snapshot retained at root, full native macOS gate passed.
- `preparation_workflow_in_desktop_adapter`: fixed | 8a8bc7e (extraction), ca029d0 (reexports) | workspace gates, production `preparation.rs` is only shared engine reexports, remaining code is `native_worker_previews_then_prepares_only_after_explicit_request`, which passed.

Final acceptance: `CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh`
passed, including the release binary's under-12-MB gate and bundle/release-script
self-tests. Snapshot-feature compilation also passed. The workspace run includes
248 native unit tests and 2 native process tests. Three pre-existing ignored
tests remain ignored: the optional Poppler oracle and two release benchmarks.
Cargo reports the existing future-incompatibility notice for `block v0.1.6`.
No Desloppify command, push, real-library mutation, signing/publishing operation,
or physical reader write was performed. Simulated reader workflows do not prove
physical Kindle compatibility.
