You are the Codex implementer for Takio Packet 006.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/006-bun-store-initialization-safety.md` exactly. Treat that packet, the current unmerged `@takio/library-store-bun` adapter and tests, and the existing contract as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the current unmerged `packages/library-store-bun` implementation and its focused tests.
- Do not change `@takio/library-contract`, `@takio/core`, public APIs, contract result shapes, error codes, or the initial schema version (`1`).
- For a database at `PRAGMA user_version = 0`, detect any non-internal SQLite schema object before Takio initialization. Reject it with exactly `{ ok: false, error: { code: "incompatible-schema" } }`.
- That rejection must not create/stamp Takio schema: it must leave `user_version` at `0` and create no Takio schema object.
- Preserve successful empty version-0 initialization to the existing v1 schema.
- Make test lifecycle cleanup robust: every adapter instance created in a test must be closed in a `finally`-equivalent path even when an assertion throws, and temporary-directory cleanup must run after those close attempts.
- Do not add CLI/Tauri/desktop work, production default paths, migrations beyond v1 initialization, external dependencies, lockfile changes, SQLite wrappers/ORMs, or unrelated code/docs/formatting changes.

Required before final response:
1. Run focused adapter checks and tests. They must prove both the unsafe pre-existing-schema rejection/non-mutation behavior and reliable lifecycle cleanup:
   ```bash
   bun run --filter '@takio/library-store-bun' check
   bun run --filter '@takio/library-store-bun' test
   ```
2. Run the clean declared-artifact dependency-closure gate exactly:
   ```bash
   rm -rf packages/core/dist packages/library-contract/dist packages/library-store-bun/dist
   bun run --filter '@takio/library-store-bun' build
   test -f packages/core/dist/index.js
   test -f packages/core/dist/index.d.ts
   test -f packages/library-contract/dist/index.js
   test -f packages/library-contract/dist/index.d.ts
   test -f packages/library-store-bun/dist/index.js
   test -f packages/library-store-bun/dist/index.d.ts
   ```
3. Run the full workspace gates after that clean build:
   ```bash
   bun run check
   bun run test
   bun run build
   git diff --check
   ```
4. Review the diff for scope discipline. Confirm explicitly that no contract/API/schema-version, CLI/Tauri/default-path/migration/external-dependency, or unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(storage): harden Bun store initialization
   ```
6. Respond with focused-test evidence for the rejected nonempty version-0 database, non-mutation evidence, cleanup strategy/evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If the required preflight cannot reject without altering schema state, cleanup cannot be made reliable without broadening the adapter API, the clean dependency-closure gate fails, or a worktree operation is blocked, stop and report the blocker. Do not weaken the rejection/non-mutation or cleanup requirements.
