# Native macOS release

The desktop artifact is the standalone Rust/GPUI `takio-desktop` application.
There is no renderer runtime, sidecar, or Bun runtime in the bundle. The initial
distribution target is Apple Silicon macOS 13 or newer. The CLI/TUI and reusable
Bun packages remain supported independently.

## Local packaging, no credentials

```sh
bun install --frozen-lockfile
bun run check:native:macos
bash scripts/verify-release-version.sh v0.1.0
bun run package:macos
(cd dist/releases && shasum -a 256 --check Takio-0.1.0-macos-arm64-local.dmg.sha256)
```

Use the current release version instead of `0.1.0` after a version bump.
`package:macos` builds the native release binary, creates an ad-hoc signed
`dist/Takio.app`, validates its architecture, version, minimum OS, dependencies
and signature, and smoke-launches it with a disposable library and profile.
It creates a compressed read-only DMG containing `Takio.app` and an Applications
shortcut, mounts it read-only, verifies the enclosed app, and writes a checksum
of the final DMG bytes. Output is
`dist/releases/Takio-<version>-macos-arm64-local.dmg` plus `.sha256`.

**Local artifacts are not notarized distribution artifacts.** Ad-hoc signing
proves bundle integrity, not Apple publisher trust. Local mode never discovers
signing identities, reads credentials from a keychain, or contacts Apple's
notarization service, even if credential environment variables are present.

## Explicit signed/notarized distribution

Only run this after authorization to submit the built app to Apple:

```sh
bash scripts/package-macos-release.sh --distribution
```

Supply an already installed Developer ID Application identity using
`APPLE_SIGNING_IDENTITY`, plus either an existing `APPLE_NOTARY_PROFILE` keychain
profile or all of `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and
`APPLE_TEAM_ID`. Do not put secrets in source files or command history. The
script neither acquires credentials nor creates accounts/profiles. Missing
credentials, rejected submissions, signing errors, and stapling errors fail
closed rather than falling back to a falsely labeled distribution build.

The script signs the native app with hardened runtime and secure timestamp,
submits a zipped copy with `notarytool --wait`, requires an Accepted result,
staples and validates the app ticket, and assesses the app with Gatekeeper.
It then creates/signs/notarizes/staples the DMG and verifies the mounted app again
in distribution mode before writing its checksum. Output is
`dist/releases/Takio-<version>-macos-arm64-distribution.dmg` plus `.sha256`.
The `dist/Takio.app` development bundle remains ad-hoc signed. The distribution
app is the copy inside the verified distribution DMG.

Apple's reference workflow is **Customizing the notarization workflow** in the
Apple Developer Security documentation. Do not treat mocked release-script
tests as evidence of an accepted Apple submission or clean-Mac approval.

## CI and release artifacts

- Root `build`, `check`, and `test` include both Rust CLI and GPUI on macOS, and
  the CLI on other hosts, plus the retained Bun packages. Native macOS CI also
  runs workspace formatting/strict Clippy/tests, startup budgets and local DMG
  packaging. Bun's former Electron-specific audit exception is removed.
- Keep `package.json` and the Cargo workspace package version synchronized.
  `verify-release-version.sh` checks the actual `takio` and `takio-desktop`
  package versions from Cargo metadata, including overridden package versions.
  Bundle verification checks both `CFBundleVersion` and
  `CFBundleShortVersionString` against the root version.
- Pushing an annotated `vX.Y.Z` tag on `main` builds CLI archives and a clearly
  labeled local DMG as workflow artifacts, not a public release.
- A manually authorized **Release artifacts** run with `distribution=true`
  enables signing/notarization using existing repository secrets:
  `APPLE_CERTIFICATE` (base64 P12), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
  An explicitly requested distribution run missing any secret fails.
- To create a draft release, select the annotated tag and explicitly set both
  `distribution=true` and `publish=true`. Only that final job has repository
  write permission. It requires two CLI archives, one native distribution DMG,
  their three SHA-256 sidecars, and successful checksum verification. Local
  DMGs cannot enter this job. Existing tags/releases are never replaced.
- Publishing the draft remains a separate maintainer decision after the
  acceptance checklist. No workflow, signing submission, tag push, or release
  publication is performed merely by changing these scripts.

The standalone CLI archive is a terminal distribution, not a notarized app.
Its checksum detects corruption but does not establish Apple publisher trust.

## Update and forward rollback

There is no background updater. Back up the library before changing versions.
After verifying the downloaded checksum and distribution gates, quit Takio and
replace only the application bundle. Library data and profile preferences live
outside the bundle. This does not guarantee an old binary can read a newer
schema, so do not promise safe arbitrary downgrades.

For a bad release:

1. Stop promoting it and record the affected version. Do not reuse its tag or
   silently replace published bytes.
2. Restore last-good application behavior in a **new higher patch version**,
   retaining required forward-compatible schema handling.
3. Test it against an isolated copy of a backup made by the affected version.
   Use `takio library restore-backup --source <backup> --db <new-folder>/library.sqlite`
   and `takio library verify --db <new-folder>/library.sqlite`. Never overwrite
   the current library or assume external reference bytes were backed up.
4. Repeat native UI, distribution, and clean-Mac acceptance for the higher
   version, then publish only with explicit maintainer authorization.
5. Install over the affected version and verify the unchanged current library
   plus the separate restored copy before declaring forward rollback complete.

Reinstalling a previous app is only a supported recovery experiment with an
isolated compatible library copy, not the default production rollback strategy.
