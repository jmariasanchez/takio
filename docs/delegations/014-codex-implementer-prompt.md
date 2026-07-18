You are the Codex implementer for Takio Packet 014.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/014-cli-root-help-library-regression.md` exactly. Treat the current unmerged Packet 008–013 library command group and focused CLI tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the unmerged library Commander error-protocol implementation in `apps/cli/src/main.ts` and focused CLI real-process tests.
- Make root-owned `takio help library`, `takio help library add`, and `takio help library list` preserve normal Commander help prose on stdout only, empty stderr, exit status `0`, and no JSON error object.
- Retain every Packet 013 direct library-owned help route as one physical JSON stdout failure record with `{ "ok": false, "error": { "code": "invalid-arguments" } }`, empty stderr, no prose, and nonzero exit.
- Retain prior direct library error protocol behavior, root `--help`, and established top-level error diagnostics.
- Preserve normal add/list success and caller-required `--db <path>` behavior.
- Add real-process tests for all three root-owned help routes, including stdout Commander prose, empty stderr, zero status, and no JSON-error assertions; retain regression coverage for direct library help/error routes.
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
4. Review the diff for scope discipline. Confirm explicitly that only the unmerged library protocol/focused tests changed and no root/top-level-command-surface, dependency/lockfile/workspace/build/adapter/core/contract/database/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(cli): preserve root library help
   ```
6. Respond with real-process evidence for all three root-owned help routes, direct-help/error regression proof, root/top-level preservation evidence, valid add/list explicit-path preservation evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If root-owned help cannot be restored without weakening the direct library protocol or changing root/top-level behavior beyond the specified regression, real-process tests cannot prove the stream/status contract, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken either side of the help-routing contract.
