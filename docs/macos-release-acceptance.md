# macOS Release Acceptance

Takio does not currently ship a live update service. A macOS release is accepted by publishing a notarized DMG and its SHA-256 sidecar from the GitHub release workflow. Rollback is therefore a release-management action: withdraw the bad draft or published release asset, re-publish the last known-good DMG and checksum, and keep the SemVer tag history immutable.

## Native build gate

Run on macOS:

```sh
bun install --frozen-lockfile
bun run check:native:macos
```

`check:native:macos` runs the Rust CLI tests, checks the Electron workspace, and
builds the native Rust sidecar through Cargo before the desktop bundle is
assembled. The sidecar has no Bun runtime dependency.

## Bundle acceptance gate

Local unsigned app:

```sh
bun run package:macos
```

`package:macos` builds the `.app` and DMG with Electron Builder, verifies the app bundle, verifies the DMG with `hdiutil imageinfo`, `hdiutil verify`, a read-only attach, and mounted bundle checks, then writes the `.sha256` sidecar.

Distribution app with Apple credentials available:

```sh
bash scripts/verify-macos-bundle.sh --distribution apps/desktop/release/mac-arm64/Takio.app
xcrun stapler validate apps/desktop/release/*.dmg
(cd apps/desktop/release && shasum -a 256 ./*.dmg > Takio.dmg.sha256)
```

The verifier rejects architecture mismatches, executable minimum-macOS drift above the bundle declaration, non-system absolute dynamic-library dependencies such as `/nix/store`, and invalid signatures. Distribution mode additionally requires a signing team, hardened runtime, matching team IDs, and a Gatekeeper assessment.

## Update and rollback acceptance

Because there is no live updater, acceptance is file based:

1. The tag must match `package.json` and `apps/desktop/package.json` via `scripts/verify-release-version.sh`.
2. The release workflow must upload exactly the CLI archives, DMG, and matching `.sha256` files, then verify every checksum before creating the draft release.
3. A user can update by downloading the new DMG, verifying the published checksum, and replacing the installed app.
4. A user can roll back by downloading the previous release DMG, verifying its checksum, and replacing the installed app. User data is outside the app bundle, so app replacement does not intentionally modify libraries or preferences.
5. If Apple signing or notarization credentials are absent, CI must say so explicitly and only run local bundle gates. It must not claim distribution readiness.

## Remaining interactive gate

The strongest non-interactive native smoke test is `open -W -n Takio.app` with an isolated data directory plus `scripts/verify-macos-bundle.sh`. Full desktop acceptance still requires a human or unblocked browser/GUI automation to import a document, relaunch, confirm persistence, and test rollback by reinstalling the previous DMG. Do not describe that as completed unless it was actually exercised.
