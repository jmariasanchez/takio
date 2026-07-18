You are the Codex implementer for Takio Packet 012.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/012-cli-library-protocol-isolation.md` exactly. Treat the current unmerged Packet 008–011 CLI library protocol and focused tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the unmerged CLI library error-protocol implementation in `apps/cli/src/main.ts` and focused CLI tests.
- Isolate Commander output/error configuration to the library command group or its explicit execution boundary. The library JSON protocol must not suppress or redirect established stderr/prose behavior for unrelated top-level commands.
- In real spawned-process tests, make both `takio library list --help` and `takio library nope` produce exactly one physical JSON stdout line parsing to `{ ok: false, error: { code: "invalid-arguments" } }`, empty stderr, and nonzero exit status.
- Add real-process regression tests proving an invalid top-level `takio plan` and an unknown top-level command retain their pre-existing stderr/prose diagnostics and nonzero behavior. They must not become library JSON or empty-stderr paths.
- Preserve normal add/list success and caller-required `--db <path>` behavior.
- Scope temporary database setup/cleanup to storage tests only. Initialize fixture state before setup can fail, guard cleanup of optional paths/handles, close handles before deletion, and keep help/error-only tests free of database fixtures.
- Do not alter command surface, dependencies, `bun.lock`, workspace/build scripts, adapter/core/contract APIs, database/storage/schema/default paths, desktop/Tauri, or unrelated behavior/files.

Required before final response:
1. Run focused CLI checks and tests:
   ```bash
   bun run --filter '@takio/cli' check
   bun run --filter '@takio/cli' test
   ```
2. Run the clean core/contract/adapter/CLI artifact gate exactly:
   ```bash
   rm -rf packages/core/dist packages/library-contract/dist packages/library-store-bun/dist apps/cli/dist
   bun run --filter '@takio/cli' build
   test -f packages/core/dist/index.js
   test -f packages/core/dist/index.d.ts
   test -f packages/library-contract/dist/index.js
   test -f packages/library-contract/dist/index.d.ts
   test -f packages/library-store-bun/dist/index.js
   test -f packages/library-store-bun/dist/index.d.ts
   test -f apps/cli/dist/main.js
   ```
3. Run full workspace gates after the clean build:
   ```bash
   bun run check
   bun run test
   bun run build
   git diff --check
   ```
4. Review the diff for scope discipline. Confirm explicitly that only the unmerged library protocol/focused tests changed and no command-surface/dependency/lockfile/workspace/build/adapter/core/contract/database/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(cli): isolate library error protocol
   ```
6. Respond with real-process library stdout/stderr/status evidence, physical-line/parsed-envelope proof, top-level regression evidence, storage-fixture cleanup evidence, valid add/list explicit-path preservation evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If library protocol isolation cannot preserve pre-existing top-level diagnostics, real-process tests cannot capture stdout/stderr/status reliably, fixture cleanup cannot be safely scoped/guarded, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken stream-isolation, physical-line, nonzero, or cleanup requirements.
