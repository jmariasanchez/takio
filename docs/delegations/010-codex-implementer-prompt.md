You are the Codex implementer for Takio Packet 010.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/010-cli-json-physical-line-test-remediation.md` exactly. Treat the current unmerged Packet 008/009 CLI implementation and focused tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only the unmerged CLI focused test helper/test file.
- Preserve the exact-one-write assertion for every library-command output path.
- Before `JSON.parse`, assert that the one captured stdout string contains neither `\n` nor `\r`. Parse that unchanged physical line only after both checks pass.
- Retain parsed success/error envelope assertions for add, separate-invocation list, missing `--db`, and duplicate add.
- Retain explicit nonzero failure-behavior assertions.
- Do not change CLI runtime behavior, commands, output serialization, error mapping, exit behavior, dependencies, `bun.lock`, workspace/build scripts, adapter/core/contract APIs, storage/schema/default paths, desktop/Tauri, or unrelated files.

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
4. Review the diff for scope discipline. Confirm explicitly that only the unmerged CLI focused tests changed and no runtime/command/dependency/lockfile/workspace/build/adapter/core/contract/storage/schema/default-path/desktop/Tauri/unrelated change was made.
5. Create exactly one micro-commit with this exact message:
   ```text
   test(cli): require single-line library JSON
   ```
6. Respond with exact-one-write plus physical-line (`\n`/`\r` absence) evidence, parsed-envelope/nonzero-error evidence, complete verification output, generated-artifact evidence, scoped file list, commit SHA, and every skipped check or blocker.

If the output helper cannot assert physical one-line output without changing runtime behavior, the clean dependency-closure build fails, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or weaken the physical-line, parseability, or nonzero requirements.
