You are the Codex implementer for Takio Packet 011.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/011-cli-library-json-edge-remediation.md` exactly. Treat the current unmerged Packet 008–010 CLI library command group and focused tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the unmerged library command group in `apps/cli/src/main.ts` and focused CLI tests.
- Make `takio library list --help` and an unknown nested command such as `takio library nope` each emit exactly one single-line JSON failure on stdout: `{ "ok": false, "error": { "code": "invalid-arguments" } }`.
- Both paths must exit nonzero and must emit no Commander usage/help/prose on stdout.
- For both paths, tests must assert exactly one captured write, no `\n` or `\r`, parse with `JSON.parse`, assert the structured `invalid-arguments` envelope, assert absence of Commander prose, and retain nonzero behavior checks.
- Preserve normal add/list success paths and the caller-required `--db <path>` / no-default-path policy.
- Do not change dependencies, `bun.lock`, workspace/build scripts, adapter/core/contract APIs, database/storage/schema/default paths, desktop/Tauri, or unrelated behavior/files.

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
4. Review the diff for scope discipline. Confirm explicitly that only the unmerged library command group/focused tests changed and no dependency/lockfile/workspace/build/adapter/core/contract/database/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   fix(cli): normalize library command errors
   ```
6. Respond with edge-path JSON/physical-line/parsed-envelope/no-prose/nonzero evidence, valid add/list and explicit-path preservation evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If Commander cannot be normalized for the two specified nested paths without changing unrelated command behavior, the protocol tests cannot prove one physical JSON line, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken the JSON/no-prose/nonzero requirements.
