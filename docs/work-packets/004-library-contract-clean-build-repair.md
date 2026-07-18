# Packet 004 — Library Contract Clean-Build Repair

**Horizon:** Foundation — Durable Local Library Storage

**Trigger:** Packet 003 integration verification found that `@takio/library-contract` advertises and imports `@takio/core`, but its standalone build fails after ignored generated artifacts are removed because TypeScript cannot resolve `@takio/core` declarations.

**Objective:** Make the existing `@takio/library-contract` build deterministic from a clean generated-artifact state by applying the smallest build-orchestration repair necessary to build its declared workspace dependency before contract declarations are checked.

## Scope

**In scope**

- The minimum build-orchestration change needed for `bun run --filter '@takio/library-contract' build` to succeed after both `packages/core/dist` and `packages/library-contract/dist` are deleted.
- `packages/library-contract/package.json` only, unless a different existing build-orchestration file is demonstrably required and no broader change can satisfy the objective.
- A narrowly scoped regression check only if it can be added without changing runtime behavior, package APIs, dependencies, or product source.

**Out of scope**

- Any runtime, public API, domain, contract, or test-behavior change.
- Any source change under `packages/core/src`, `packages/library-contract/src`, or application source.
- Dependency additions, lockfile changes, package-version changes, or TypeScript configuration redesign.
- SQLite, Bun runtime APIs, filesystem persistence, SQL, migrations, database files, CLI behavior, Tauri/Rust code, or desktop changes.
- Root workspace-script changes unless the implementer proves the package-local orchestration repair cannot meet the standalone-build requirement.
- Unrelated cleanup, formatting churn, or future storage implementation.

## Required behavior

1. After deleting both relevant ignored artifact directories, the standalone library-contract build succeeds without relying on pre-existing `@takio/core` declarations.
2. That standalone build regenerates the `@takio/core` declaration entrypoint required by the contract compilation and the `@takio/library-contract` runtime and declaration entrypoints advertised by its package metadata.
3. The existing root workspace build order and all existing runtime/API behavior remain unchanged.
4. No Bun/SQLite/Tauri implementation or product code is added.

## Acceptance criteria

- The change is the smallest deterministic build-orchestration repair and is limited to the authorized scope.
- The contract package still exposes exactly the same runtime/public API after the repair.
- The clean generated-artifact gate succeeds exactly:

```bash
rm -rf packages/core/dist packages/library-contract/dist
bun run --filter '@takio/library-contract' build
test -f packages/core/dist/index.js
test -f packages/core/dist/index.d.ts
test -f packages/library-contract/dist/index.js
test -f packages/library-contract/dist/index.d.ts
```

- The complete workspace passes after the clean standalone build:

```bash
bun run check
bun run test
bun run build
git diff --check
```

## Required evidence

- The exact clean-artifact removal and standalone-build output.
- Evidence that all four required generated files exist after the standalone build.
- Exact output from every workspace gate.
- A focused diff review explaining why the selected build-orchestration change is the smallest viable repair.
- An explicit statement that no runtime/API/dependency/SQLite/Tauri change was made.
- An explicit disclosure of every skipped check or blocker.

## Micro-commit requirement

After all verification passes, create exactly one commit:

```text
fix(build): restore contract clean build
```

The commit must contain only this remediation packet's build-orchestration repair and any strictly necessary narrow regression check. Stop and report a blocker instead of broadening scope.

## Rollback

Revert the single packet commit. The repair changes build orchestration only; it creates no persistent data and does not alter runtime behavior or package APIs.
