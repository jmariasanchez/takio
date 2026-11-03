# Native-only reliability and completion

Date: 2026-11-03

The user requested resolution of the current recovery, release, performance,
metadata and native quality complications, and removal of the Electron app.
This is a bounded implementation session, not permission to publish releases,
access signing accounts, change personal libraries or write to a physical reader.
The focused native-library product direction remains authoritative.

## Acceptance recorded before implementation

- Recovery: reproduce the noncanonical macOS temp-path failure, fix the engine
  rather than bypassing its tests, and retain traversal/symlink/no-overwrite
  protections. A corrupt startup library must offer a safe way to choose an
  existing library or restore a separate copy without modifying the original.
- Automatic recovery copies: explicitly opt in, choose storage outside the
  current library, state the schedule and retention policy, and disable without
  deleting backups. Run only while the native app is open, on its engine worker.
  Reuse verified whole-library backup and restore rather than a new format.
  Explain external-reference/job exclusions and preserve successful copies when
  preferences fail. Never install a background service.
- Native-only delivery: delete the Electron application and active build/release
  dependencies on it, keep reusable Rust/Bun packages and CLI/TUI workflows,
  and make CI/package/version checks target the GPUI app. Distribution credentials
  are optional for local checks but mandatory for claiming distribution readiness.
- Metadata: import useful PDF author metadata with bounded native parsing, correct
  string decoding and malformed/encrypted fallback. Preserve explicit titles,
  useful filename fallbacks and originals. Test object streams and limits against
  independently generated fixtures/oracles.
- Responsiveness: preserve literal query/filter semantics and stale-result safety,
  measure before/after in isolated 10k libraries, and prevent cold reader scans
  from blocking catalogue interaction. Distinguish state settlement, rendered
  frame completion and actual OS input/display measurements.
- Accessibility: expose semantic roles, labels, selection and actionable controls
  through the pinned GPUI accessibility API and test actual accessible trees and
  keyboard paths. Record any macOS permission or VoiceOver validation blocker.

## Reproducible checks

- `cargo fmt --all --check`
- `cargo test --offline --workspace` with the ordinary environment, plus explicit
  noncanonical temp-path recovery regressions
- `cargo clippy --offline --workspace --all-targets -- -D warnings`
- Snapshot-feature tests/Clippy when native render instrumentation changes
- `bash scripts/bench-desktop-native.sh --interactions` on an otherwise idle machine
- Native package/DMG verification against an isolated profile
- Native state/window/accessible-tree tests for each changed workflow
- `git diff --check` and inspection for references to removed Electron paths

## Initial observation

The working tree was clean at `2b98134`. A coordinator run of
`cargo test --offline -p takio-desktop recovery` passed 12 tests in the inherited
environment. The historical alias bug therefore needs an explicit alias
reproduction, not an assumption that every current test invocation fails.

Physical reading confirmation is still a separate human/device gate. Automated
file hashes, rendered snapshots and temporary reader directories cannot prove it.

## Results

Implementation and observed results will be recorded here as slices complete.
