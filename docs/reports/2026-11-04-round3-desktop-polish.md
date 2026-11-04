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
