You are the Codex implementer for Takio Packet 007.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/007-atomic-bun-store-initialization.md` exactly. Treat that packet, the current unmerged `@takio/library-store-bun` adapter and focused tests, and the existing contract as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the current unmerged `packages/library-store-bun` implementation and its focused tests.
- Do not change `@takio/library-contract`, `@takio/core`, public APIs, contract result shapes, error codes, or the initial schema version (`1`).
- For version-0 first-time initialization, serialize the version read, non-internal `sqlite_schema` preflight, existing v1 DDL, and `PRAGMA user_version = 1` stamp in one immediate transaction or equivalent lock-protected sequence.
- Preserve Packet 006 behavior: a version-0 database with a pre-existing non-`sqlite_%` schema object returns exactly `{ ok: false, error: { code: "incompatible-schema" } }` without creating Takio schema or changing `user_version`.
- Add a deterministic two-connection regression test with explicit synchronization. Do not use sleeps, polling, or probabilistic scheduling. It must prove a competing connection cannot inject a schema object between preflight and v1 initialization, and that no unsafe version-0 database becomes Takio-stamped.
- A narrowly scoped non-public test seam is permitted only when necessary for deterministic coordination; do not expose it through the adapter package API or the library contract.
- Keep Packet 006's robust adapter-close/temporary-directory cleanup guarantees.
- Do not add CLI/Tauri/desktop work, production default paths, migrations beyond v1 initialization, external dependencies, lockfile changes, SQLite wrappers/ORMs, retries/background coordination, or unrelated code/docs/formatting changes.

Required before final response:
1. Run focused adapter checks and tests. They must prove both the retained pre-existing-schema non-mutation behavior and the deterministic two-connection atomic-initialization regression:
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
4. Review the diff for scope discipline. Confirm explicitly that no contract/API/schema-v1, CLI/Tauri/default-path/migration/external-dependency, or unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(storage): serialize Bun store initialization
   ```
6. Respond with the immediate-transaction/lock strategy, deterministic two-connection synchronization/test evidence, retained non-mutation evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If atomic initialization cannot be demonstrated without a public contract/API change, the competing write cannot be deterministically coordinated, the required non-mutation behavior regresses, the clean dependency-closure gate fails, or a worktree operation is blocked, stop and report the blocker. Do not weaken the atomicity or test-determinism requirements.
