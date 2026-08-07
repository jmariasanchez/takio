# macOS release

The tagged release workflow builds checksummed CLI artifacts and an Apple
Silicon Developer ID-signed, notarized macOS DMG. It creates a draft release
only after the exact tag source passes the repository checks and the bundle
passes the distribution verifier; a maintainer publishes it after clean-Mac
acceptance.

The standalone macOS CLI is a terminal distribution, not a notarized app. Its
checksum detects corruption but does not establish Apple publisher trust. The
notarized DMG on macOS 11 or newer is the supported macOS v1 installation
path. Intel and automatic update support are outside this baseline.

## Required GitHub Actions secrets

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12` file.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting that `.p12` file.
- `APPLE_SIGNING_IDENTITY`: its full identity, for example
  `Developer ID Application: Example, Inc. (ABCDE12345)`.
- `APPLE_ID`: Apple ID used for notarization.
- `APPLE_PASSWORD`: app-specific password for that Apple ID.
- `APPLE_TEAM_ID`: ten-character Apple Developer team ID.

Keep the certificate and passwords out of the repository. The Apple account
must have permission to submit software for notarization.

## Release

1. Set the same version in `package.json`, `apps/desktop/package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, and the `[package]` section of
   `apps/desktop/src-tauri/Cargo.toml`.
2. Run `bash scripts/verify-release-version.sh vX.Y.Z` and the normal CI suite.
3. Back up a representative library with
   `takio library backup --dest /path/to/new-backup-directory` and keep the
   backup outside the application data directory.
4. Push an annotated `vX.Y.Z` tag whose commit is on `main`. The Release
   workflow reruns the source checks, signs, notarizes, verifies, and attaches
   the DMG, CLI artifacts, and all three checksums to a draft release.
5. Confirm the CI and Release runs for the tag's exact commit both succeeded.
   From a maintainer account, download all six draft assets, then run
   `shasum -a 256 --check ./*.sha256` before testing the DMG.
6. On a clean Apple Silicon Mac, verify that Gatekeeper opens Takio without an
   override. Import documents, queue two conversions, and confirm they run in
   order. Relaunch during or after a conversion and exercise interrupted-job
   retry. Export with both filename presets, quit and relaunch, and confirm the
   library is intact. Treat the standalone CLI as a terminal-only artifact.
7. Record the acceptance result in the release notes, then publish the existing
   draft release. Do not recreate the tag or replace an accepted artifact.

Do not publish a manually built DMG that has not passed:

```sh
bash scripts/verify-macos-bundle.sh --distribution /path/to/Takio.app
```

## Forward rollback

Do not reuse a tag, replace published artifacts, or enable arbitrary version
downgrades. If a release is bad:

1. Stop promoting it and record the affected version.
2. Restore the last-good source on a new patch version.
3. Preserve any required forward-compatible data migration and test it against
   a backup made by the bad release.
4. Test restore into an absent destination with
   `takio library restore-backup --source /path/to/backup --db /path/to/restored-library.db`.
5. Tag and publish the higher patch version through the same workflow.
6. Install it over the bad version, confirm the library opens unchanged, and
   verify the restored copy before declaring rollback complete.

Signed automatic updates are not part of this baseline. Add them only after a
maintainer owns the updater signing key and release endpoint.
