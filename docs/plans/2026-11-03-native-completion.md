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

### Implemented and checked

- Removed `apps/desktop` completely, its exclusive lockfile dependencies and
  active Electron build/release entry points. Reusable Bun packages and CLI/TUI
  remain. Native packaging has separate local ad-hoc and explicitly authorized
  distribution modes, exact version checks and draft-only publication guards.
- Fixed read-only verification through macOS `/var` aliases without rebasing
  attachment paths or weakening symlink/traversal checks. The ordinary inherited
  `TMPDIR` was canonical; `getconf DARWIN_USER_TEMP_DIR` reproduced seven native
  failures before the fix. The worker reran the full workspace with that real
  macOS temp root successfully. Explicit `/var/tmp` and synthetic alias regressions
  now protect against the masking environment.
- Added worker-backed startup recovery for corrupt/incompatible defaults: open
  another existing library or restore a verified separate copy. Original bytes,
  existing destinations and selected-library migration boundaries are protected.
  Valid legacy default catalogues retain the engine's verified migration backup.
- Added explicitly opt-in automatic recovery copies, daily only while the app is
  open, with all copies retained. Missing drives are not recreated. Cancellation,
  stale dialogs, library switching, nested modal pauses, failure throttling,
  disabling, Trash/managed-byte roundtrip and settings-write failure have native
  state/window and filesystem tests. No background service was installed.
- Added PDF Info author/title extraction using `lopdf` without default features.
  Classic and compressed object/xref streams, indirect strings, PDFDocEncoding,
  UTF-16, malformed/encrypted inputs, incremental metadata and source preservation
  pass parser/CLI tests. An explicit local Poppler `pdfinfo` oracle passed for
  independently constructed fixtures. Limits are 64 MiB input, 4 KiB fields and
  capped decompressed structural streams. These are not total heap/time bounds,
  and XMP-only metadata is outside this slice. Existing books are not rewritten.
- Isolated reader scans onto one worker with at most one pending scan. Catalogue
  queries complete while a test-held scan is blocked. Switching/shutdown invalidate
  old work, and Eject rejects active reads instead of unmounting beneath them.
  Search coalescing is 8 ms instead of 60 ms with stale-action guards retained.
- Added production AccessKit roles, labels, values, selected/disabled state and
  keyboard activation/focus paths. Seven native checks exercise element metadata
  and keyboard behavior. Light/dark text-token contrast passes 4.5:1 tests across
  selection, stripe and hover backgrounds. These are not a full accessibility audit.

### Validation observed by the coordinator

- `cargo test --offline --workspace`, also rerun with
  `TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"`: 477 tests passed (180 shared library,
  64 CLI, 2 custom-field, 2 PDF import, 229 native). Two opt-in performance tests
  and one external Poppler oracle are intentionally outside the default run.
- `cargo test --offline -p takio --test pdf_metadata
  synthetic_pdf_metadata_matches_poppler_oracle -- --ignored --nocapture`: passed.
- `cargo fmt --all --check`, strict workspace/all-target Clippy, snapshot-feature
  tests (229 native) and strict snapshot-feature Clippy: passed. Cargo reports an
  upstream future-incompatibility warning for `block 0.1.6`, not a denied project lint.
- Release bundle/version/orchestration rejection self-tests: passed. These mock
  Apple tools and do not prove signing/notarization. A production-only scroll
  accessor compile failure, hidden by GPUI test-support features, was found by
  actual packaging and corrected to observe the applied production scroll offset.
- Retained Bun packages: coordinator independently verified frozen install,
  build, typecheck and 216 tests. Local Bun was 1.4.4 while CI pins 1.3.14.
- The actual local packaged production entry point rendered the corrupt-startup
  recovery screen with Open Existing Library, Restore Backup to New Folder and
  Quit controls. The isolated corrupt catalogue's exact bytes remained unchanged,
  with no extra files created. No live dialog interaction was claimed without AX
  permission. The disposable process was closed after the scoped screenshot.

### Remaining acceptance boundaries

- GPUI TestWindow does not activate AccessKit or support platform action injection.
  macOS Accessibility permission is absent. Real platform-tree/VoiceOver checks
  remain unverified, despite passing element-metadata and keyboard tests.
- Physical Kindle/KOReader reading still requires opening the transferred book
  on hardware. No reader was connected or written during this session.
- Real Developer ID signing/notarization, clean-Mac Gatekeeper installation,
  hosted workflow execution and upgrade/rollback acceptance require separate
  credentials, environment and authorization. No release was published.
- Input-handler/paint-submission benchmarks do not prove hardware-keyboard,
  wheel-event, GPU-completion, 120 Hz scrolling or display-scanout latency.
  Harness startup bypasses remembered-library lookup and the recovery wrapper.

### Measured responsiveness and remaining size gate

Five processes with five cycles each, 25 samples per operation, on the generated
10,000-book library. Runs refused concurrent Cargo/rustc activity. The original
release profile is retained; experimental size overrides were discarded.

| State-dispatch scope | Before p95 (ms) | After p95 (ms) |
| --- | ---: | ---: |
| Search matching 5,000 books | 110.605 | 50.355 |
| Clear search to 10,000 books | 124.648 | 69.551 |
| Select-all/reload settlement | 57.951 | 46.869 |
| Title-sort initiating UI call | 0.044 | 0.108 |

State-scope startup medians were 89.181 ms first paint, 152.177 ms first query and
124,320 KiB RSS. All startup/state budgets passed. Sort dispatch remains far below
its 8 ms budget, despite the small increase shown above.

The new input-handler-to-next-frame-after-paint probe does **not** meet the separate
below-80-ms target: matching-search p95 97.521 ms, clearing-search p95 84.182 ms.
Programmatic scroll-to-bottom/top completed at p95 16.678/17.181 ms with verified
scroll offsets, not at the unproven 120 Hz target. Counts, order, selected IDs and
scroll destination checks all passed. Do not describe this as hardware input,
GPU completion or smooth wheel-scrolling certification.

The native executable is 12,504,400 bytes, above the existing strict 12,000,000-byte
budget. The size check remains intact, so `check:native:macos` and its CI lane are
**not green** despite passing tests, Clippy and local artifact verification.
Targeted `lopdf` size optimization reached 12,439,504 bytes, adding engine size
optimization reached 12,390,176, native-shell size optimization grew to 14,014,160,
and a renderer-only experiment reached 12,307,280. None met the gate. All overrides
were removed rather than relaxing the budget or silently accepting a runtime
tradeoff. Further structural size work and rendered-search latency work remain.

Raw local evidence lives under `$JCODE_SCRATCH_DIR/takio-latency-20261103/`:
`baseline.log`, `final-state.log`, `final-render.log`, and the archived baseline
binary/script. Package logs and final default-temp workspace logs are in the
scratch root with the `takio-...-20261103.log` names. These disposable local logs
are not bundled or committed. Final artifact identity is recorded below.

### Final local artifact

Built from implementation commit `a0151ff` with the unchanged release profile.
`bash scripts/package-macos-release.sh` completed on November 3, 2026 at 18:02 UTC.
Native launch metrics, strict ad-hoc signing checks, DMG checksum/read-only mount,
mounted-bundle verification, ejection and the SHA-256 sidecar all passed. This is
a local artifact, not a signed/notarized distribution release or a green size gate.

- Executable: `target/release/takio-desktop`, 12,504,400 bytes.
- Executable SHA-256:
  `8b54ce8b5d8358e23e160fca262aa57a2ed245d0d3d1881eb9d121567bfd0d2e`.
- DMG: `dist/releases/Takio-0.1.0-macos-arm64-local.dmg`.
- DMG SHA-256:
  `cb23ddf565289f009cf82a2e6382d78e55358c1b4f90c31f042265dc5222aadd`.
- Final packaging log: `$JCODE_SCRATCH_DIR/takio-native-package-final-20261103.log`.

### Follow-up acceptance: cover decoding and size attribution

The linker map shows duplicate general image-decoder instantiations, including
EXR and TIFF code, in the image crate and GPUI. Investigate sharing the same
decoder entry path without dropping supported image formats. Native covers also
currently read an unbounded file before resizing. Before accepting this slice,
test all engine-produced cover formats, existing extra formats, corrupt inputs,
file-size and decoded-dimension/output limits, thumbnail dimensions and BGRA
conversion. Measure the production binary again, retain panic unwinding and the
strict size budget, and rerun native tests/Clippy and packaging.
Allocation limits are not a claim of a hard process-memory or wall-time bound.

Observed follow-up: all 232 native tests, including six cover checks, pass with
the real macOS alias temp root. Strict all-target snapshot Clippy and formatting
pass. PNG/JPEG/GIF/WebP and existing BMP/TIFF covers still decode from their bytes
with misleading extensions, preserving source bytes. Oversized input, excessive
dimensions and compressed grayscale images whose RGBA expansion exceeds the cap
are rejected. Missing/corrupt images retain the existing placeholder behavior.

This decoder entry change does not reduce executable size: with opt-level 3 the
intermediate build measured 12,570,480 bytes. A whole-program opt-level 2 experiment
measured 11,976,080 bytes without disabling unwinding or changing any threshold.
Its idle 25-sample rendered probe passed startup/state budgets but still missed
search at 103.086 ms matching and 83.338 ms clearing. This is preliminary evidence,
not completion of the latency or final integrated packaging gate. Further query
work is in progress, and all final measurements must use the integrated source.
