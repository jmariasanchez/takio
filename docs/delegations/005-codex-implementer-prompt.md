You are the Codex implementer for Takio Packet 005.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/005-bun-sqlite-library-store.md` exactly. Treat that packet, `@takio/core`, `@takio/library-contract`, existing package metadata, and tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Start by inspecting the current `LibraryStore` contract, `LibraryItem` schema, package build scripts, and Packet 004's dependency-closure repair.
- Create only `packages/library-store-bun`, its focused tests/documentation, and strictly necessary root workspace-script changes.
- Implement the existing contract; do not change its public API, result types, error codes, tests, or `@takio/core` domain behavior.
- Use `import { Database } from "bun:sqlite"` only inside the new adapter package. Add no external SQLite package, ORM, wrapper, or dependency.
- Require an explicit caller-injected database path. Tests must use temporary injected database paths and must not touch the repository or a real user-data location.
- Implement initial schema version `1` only, including initialization and safe reopening of an already-v1 database.
- Implement only durable open, add, get, list, remove, and close/reopen behavior required by the packet.
- Do not add CLI integration, Tauri/Rust/desktop work, production default path selection, environment configuration, migrations beyond v1 initialization, sync, conversion, queues, import, metadata, search, covers, tags, collections, cloud, authentication, or unrelated cleanup.

Required before final response:
1. Run focused adapter checks and tests, including the temporary-path close/reopen durable round trip and schema-version assertions:
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
4. Review the diff for scope discipline. Confirm that the adapter has no CLI/Tauri integration, production default data path, post-v1 migration, external dependency, or unrelated product feature.
5. Create exactly one micro-commit with this exact message:
   ```text
   feat(storage): add Bun SQLite library store
   ```
6. Respond with the adapter API, schema-v1 decision, injected temporary database-path round-trip evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, deferred decisions, and every skipped check or blocker.

If the contract cannot be implemented without changing its API, the clean dependency-closure build fails, a required test cannot use an injected temporary path, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or substitute unverified behavior.
