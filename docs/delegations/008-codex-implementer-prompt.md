You are the Codex implementer for Takio Packet 008.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/008-cli-library-storage-smoke.md` exactly. Treat that packet, the current CLI shape, `@takio/library-contract`, and the integrated `@takio/library-store-bun` public API as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Touch only `apps/cli`, strictly necessary root/workspace metadata and `bun.lock` workspace registration, and narrowly necessary CLI build orchestration.
- Start by inspecting `apps/cli/src/main.ts`, its tests, the `BunSqliteLibraryStore` constructor/open/add/list/close methods, and existing package build scripts.
- Add exactly two non-interactive commands: `takio library add` and `takio library list`.
- Both commands require caller-supplied `--db <path>`; do not choose a default, production, platform, environment-derived, or configured path.
- `library add` requires `--id`, `--title`, `--source-path`, `--format`, and `--added-at`; `library list` requires no operation flags beyond `--db`.
- Emit only one stable JSON object to stdout for each storage command. Success envelopes are `{ ok: true, value: { item } }` for add and `{ ok: true, value: { items } }` for list. Failure envelopes are `{ ok: false, error: { code } }`.
- Preserve stable adapter/contract error codes. Do not emit SQLite messages, stack traces, Commander prose, tables, prompts, or mixed stdout output for these commands. Failure paths must exit nonzero.
- Close every store instance in a `finally`-equivalent path.
- Add focused temporary-path CLI tests that perform add and list through separate fresh program invocations, parse JSON, and prove durable persistence. Test missing `--db` and duplicate-add JSON failures/nonzero exits.
- Do not change core, contract, adapter APIs, schema behavior, migrations, or adapter tests.
- Do not add desktop/Tauri/Rust work, interactive UI, generic configuration, default paths, importer/search/metadata/sync/conversion/queue/device features, external dependencies, or unrelated cleanup.

Required before final response:
1. If the existing workspace dependency requires lock registration, review only the expected workspace-entry change, then run:
   ```bash
   bun install --frozen-lockfile
   ```
2. Run focused CLI checks and tests, including separate add/list invocations against one temporary explicit path and JSON failure cases:
   ```bash
   bun run --filter '@takio/cli' check
   bun run --filter '@takio/cli' test
   ```
3. Run the clean core/contract/adapter/CLI artifact gate exactly:
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
4. Run full workspace gates after the clean build:
   ```bash
   bun run check
   bun run test
   bun run build
   git diff --check
   ```
5. Review the diff for scope discipline. Confirm explicitly that no desktop/Tauri, default-path, schema/migration, generic-config, interactive UI, importer/search/metadata/sync/conversion, external-dependency, or unrelated change was made.
6. Create exactly one micro-commit with this exact message:
   ```text
   feat(cli): add JSON library storage smoke path
   ```
7. Respond with two-invocation temporary-path JSON evidence, error-envelope/nonzero evidence, store-close cleanup evidence, frozen-install and clean-artifact evidence, complete verification output, scoped file list, commit SHA, deferred decisions, and every skipped check or blocker.

If agent-safe JSON output cannot be guaranteed for a required failure path, the CLI cannot build its dependency closure from clean artifacts, a store cannot be closed before temporary-path cleanup, or a worktree operation is blocked, stop and report the blocker. Do not broaden scope or substitute unverified behavior.
