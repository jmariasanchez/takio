You are the Codex implementer for Takio Packet 009.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/009-cli-json-parse-test-remediation.md` exactly. Treat the current unmerged Packet 008 CLI implementation and its focused tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the current unmerged Packet 008 focused CLI test file(s).
- Before asserting any library-command success or error envelope, verify captured stdout contains exactly one line and parse that exact line with `JSON.parse`.
- Assert the parsed structured success envelopes for add and separate-invocation list, and parsed structured error envelopes for missing `--db` and duplicate add.
- Preserve explicit assertions that each error path exits nonzero.
- Do not join multiple output lines before parsing and do not accept JSON-looking strings that are not parseable JSON.
- Do not change CLI behavior, commands, output serialization, error mapping, exit behavior, dependencies, workspace metadata, `bun.lock`, build scripts, adapter/core/contract APIs, storage/schema/default paths, desktop/Tauri, or unrelated code/docs/formatting.

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
4. Review the diff for scope discipline. Confirm explicitly that only focused CLI tests changed and no runtime/dependency/lockfile/workspace/build/adapter/core/contract/storage/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   test(cli): parse library JSON output
   ```
6. Respond with the exact-one-line and `JSON.parse` test evidence for every success/error path, retained nonzero-failure evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If the existing CLI cannot be tested through captured one-line stdout without changing runtime behavior, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken parseability/nonzero requirements.
