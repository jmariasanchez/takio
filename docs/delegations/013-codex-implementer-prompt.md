You are the Codex implementer for Takio Packet 013.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/013-cli-library-help-protocol-remediation.md` exactly. Treat the current unmerged Packet 008–012 library command group and focused CLI tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the unmerged library command group in `apps/cli/src/main.ts` and focused CLI real-process tests.
- Normalize all of these library-owned help routes to exactly one physical stdout JSON failure line `{ "ok": false, "error": { "code": "invalid-arguments" } }`, empty stderr, and nonzero exit: `takio library --help`, `takio library add --help`, `takio library help add`, and `takio library help list`.
- For each route, tests must capture a real process's stdout/stderr/status, assert stdout has one record with no `\n` or `\r`, parse it unchanged with `JSON.parse`, assert the exact `invalid-arguments` envelope, and assert no Commander prose.
- Keep library-command configuration isolated. Preserve root/top-level help and Packet 012's pre-existing top-level invalid-plan and unknown-command diagnostics.
- Preserve normal add/list success and caller-required `--db <path>` behavior.
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
4. Review the diff for scope discipline. Confirm explicitly that only the unmerged library group/focused tests changed and no root/top-level-help, dependency/lockfile/workspace/build/adapter/core/contract/database/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(cli): normalize library help protocol
   ```
6. Respond with real-process evidence for all four help routes, physical-line/parsed-envelope/empty-stderr/nonzero/no-prose proof, root/top-level preservation evidence, valid add/list explicit-path preservation evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If the four help routes cannot be normalized without changing root/top-level help or established top-level diagnostics, real-process protocol tests cannot prove their streams/status, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken the help-protocol requirements.
