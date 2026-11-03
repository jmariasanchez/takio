# Native macOS release acceptance

Release acceptance concerns the Rust/GPUI app, not the retired Electron shell.
A local ad-hoc bundle or a fake-tool test is not proof of Developer ID trust,
notarization, clean-Mac installation, accessibility, or physical Kindle reading.

## Reproducible automated gates

On Apple Silicon macOS with Xcode's Metal toolchain:

```sh
bun install --frozen-lockfile
bun run check:native:macos
bash scripts/verify-release-version.sh v0.1.0
bun run package:macos
bash scripts/verify-macos-bundle.sh dist/Takio.app
bash scripts/verify-macos-dmg.sh dist/releases/Takio-0.1.0-macos-arm64-local.dmg
(cd dist/releases && shasum -a 256 --check Takio-0.1.0-macos-arm64-local.dmg.sha256)
```

Substitute the intended version after a version bump. Root `bun run build`,
`check`, and `test` include native GPUI on macOS and retained Bun packages.
`check:native:macos` runs workspace formatting, strict Clippy, tests, release
build and release-script self-tests. Performance gates are separate:
`bash scripts/bench-desktop-native.sh` and its supported interaction modes.

Required bundle shape is `Contents/MacOS/takio-desktop`, Info.plist and icon,
without Frameworks or sidecar directories. The verifier checks arm64, both
bundle version fields, minimum-OS load commands, only system dynamic-library
references, and strict code-signature integrity, including in local mode.
The package smoke launches with a disposable library/profile and requires valid
native first-paint/query/RSS metrics. It does not touch the user's library.

DMG verification requires a compressed read-only image, embedded checksum,
read-only mounting, the expected app and `/Applications` shortcut, and passing
mounted-bundle verification. The SHA-256 sidecar is generated after all mutations,
including stapling in distribution mode.

## Distribution gates, only with existing credentials and authorization

```sh
bash scripts/package-macos-release.sh --distribution
bash scripts/verify-macos-dmg.sh --distribution dist/releases/Takio-0.1.0-macos-arm64-distribution.dmg
(cd dist/releases && shasum -a 256 --check Takio-0.1.0-macos-arm64-distribution.dmg.sha256)
```

The explicit distribution path must pass Developer ID signing, hardened runtime,
matching signing teams, accepted Apple notarization for app and DMG, stapler
validation for both, and Gatekeeper assessment of the enclosed app. Missing
credentials never silently downgrade this request to a local success. Ordinary
packaging never uses Apple credentials or attempts account setup.

The Release artifacts workflow defaults to local artifacts. A manual authorized
run can request distribution. Draft creation additionally requires `publish=true`,
a version-matching annotated mainline tag, both CLI archives and the notarized
native DMG, exactly three matching sidecars, and verified hashes. Only the draft
job has repository write permission. No local artifact is eligible for a draft.

## End-user acceptance before publishing

Use disposable fixtures and a separate profile, not personal books:

1. Download the distribution DMG on a clean supported Mac, verify its checksum,
   install the app and open it through Finder with normal Gatekeeper checks.
   Do not strip quarantine or use an override as acceptance evidence.
2. Import files/folders by native controls and drag/drop, verify originals are
   unchanged, search/filter, edit details with Save/Cancel and relaunch for
   persistence. Exercise Trash, restore and exact-selection purge confirmation.
3. Back up the complete fixture library, restore into a new disjoint folder,
   verify the restored catalogue/files through the public CLI, and open that
   separate library in the native app. Never replace the current library.
4. With explicit hardware authorization, connect a supported physical reader,
   review/send a compatible format, verify no overwrite, eject, then open the
   book on the device. Simulated mounted directories do not satisfy this gate.
5. Test replacing the app with a higher patch release using a compatible fixture
   library and record the forward rollback exercise described in
   `docs/release-macos.md`. Do not treat a binary downgrade as schema recovery.
6. Record exact commit, OS/hardware, artifact hashes, gate results, and unresolved
   limitations before a maintainer publishes the existing draft.

## November 3, 2026 implementation evidence

- Electron application, exclusive dependencies, commands, legacy CI lane and
  obsolete startup/comparison scripts removed. Reusable Bun packages and CLI/TUI
  retained. Frozen lockfile installation passes after regeneration. All four
  retained Bun packages build/typecheck and pass 216 tests (38 core, 3 EPUB,
  41 contract, 134 store). Local checks used Bun 1.4.4; CI pins 1.3.14.
- Native bundle self-tests pass, including rejected wrong executable/version/
  architecture/minimum OS/dependencies, invalid local/distribution signatures,
  missing team/runtime, mismatched team, Gatekeeper rejection, and stale
  Frameworks/sidecars. These use fake platform tools, not Apple approval.
- Release orchestration self-tests pass for CLI/native version drift, malformed
  tags, missing explicit credentials, default local mode despite credentials,
  explicit distribution routing, rejected notarization/signing/stapling, and
  refusing to emit new distribution artifacts after those failures. These use
  synthetic tools and are not real notarization evidence.
- ShellCheck passes on the nine changed/new release/check scripts. Workflow YAML
  and every embedded Bash command parse successfully. Version verification passes
  with an empty disposable Cargo cache. Active scripts, workflows, package.json
  and lockfile no longer reference the removed desktop paths.
- Actual production packaging exposed a benchmark accessor that was available
  only with GPUI test support. It was replaced with the applied production scroll
  offset. Fresh local packaging then passed native launch metrics, strict ad-hoc
  signature verification, DMG checksum/read-only mounting, mounted-bundle checks,
  ejection and SHA-256 sidecar verification at implementation commit `a0151ff`.
  Artifact identity is recorded in `plans/2026-11-03-native-completion.md`.
- That initial executable was 12,504,400 bytes and failed the unchanged strict
  12,000,000-byte gate. Subsequent work retained unwinding and parser/cover format
  support, using whole-program opt-level 2 and `lopdf` opt-level `z`. The final
  executable is 11,927,760 bytes and the actual `check:native:macos` script passes.
  All 494 workspace tests pass, plus 235 snapshot-feature native tests and strict
  workspace/snapshot Clippy. Three release-profile PDF tests, including the
  independent Poppler oracle, also pass.
- Bounded immutable hydration reuse and background debounce dispatch pass two
  independent rendered-search runs with the existing below-80-ms p95 gate enabled.
  Matching/clearing p95: 63.216/49.969 ms and 63.273/49.956 ms. These are production
  input-handler to next-frame-after-paint measurements, not physical keystrokes,
  GPU completion, 120 Hz scrolling or display scanout. See the completion plan for
  adverse intermediate results, first-query outliers and final artifact identity.
- The final local app/DMG at implementation commit `bc4f500` also passes actual
  launch, strict ad-hoc signatures, checksum/read-only mounting, mounted-bundle
  verification, ejection and sidecar checks. A separate production-entry startup
  smoke visibly presents recovery controls for a corrupt temporary catalogue
  without changing its bytes or creating additional library entries.

Still external gates: real Developer ID/notarization/stapler/Gatekeeper approval,
clean-Mac quarantined install, a completed GitHub workflow on the exact release
commit, physical-reader acceptance, and exercised forward rollback. No Apple
account, signing credentials, release upload, or publication was accessed by this
implementation session.
