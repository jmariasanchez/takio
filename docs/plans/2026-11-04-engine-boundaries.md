# Engine boundaries and mechanical layout

The shared library moves from `apps/cli/src` to `apps/engine/src`. The engine
package is `takio-engine` and its library remains `takio`; the `takio` executable
package keeps only its CLI, TUI, and HTTP adapters. Earlier dated plans and work
packets referring to engine modules under `apps/cli/src` describe the old layout.

Acceptance, recorded before moving files:

- `cargo tree --offline -p takio-desktop -e normal` contains no `clap`, `ratatui`,
  or `tiny_http` dependency.
- `cargo fmt --all`, `cargo test --offline --workspace`, and
  `cargo clippy --offline --workspace --all-targets -- -D warnings` pass before
  each commit. CLI integration tests continue executing the `takio` binary.
- `bash scripts/test-release-scripts.sh` and
  `CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh` pass.
- Domain grouping retains public engine module paths through root re-exports.
- Unit test relocation preserves the discovered tests, using module-local
  `tests.rs` files and `#[cfg(test)] mod tests;` declarations.
- Typed error codes retain previous kebab-case wire strings and require
  exhaustive native user-message matches, with serialization coverage.

Only disposable test libraries are used. No crate downloads, publication,
personal libraries, or physical readers are involved.

## Observed evidence

The initial native dependency tree included Clap, Ratatui, and tiny_http. After
the split, the normal native tree contains none of them. The engine library name
remains `takio` without a package collision. CLI package selectors and packaged
binary names remain unchanged.

The split passes formatting, all offline workspace tests (594 passed, three
pre-existing ignored tests), and strict workspace Clippy. Release-script tests
pass, including the added engine-version mismatch check.
`CARGO_NET_OFFLINE=true bash scripts/check-native-macos.sh` passes, including
the native release build, size bound, and bundle/release script self-tests.
The existing dependency future-incompatibility warning for `block 0.1.6` remains.

Shared catalogue fixture builders are available only under the engine's
`test-support` feature, enabled by the CLI dev dependency. The normal desktop
and release binary do not enable it. Historical source links in dated plans
retain their historical meaning; current architecture, spec, README, CI paths,
release version validation, and non-macOS workspace selection use the new layout.
