You are the Codex implementer for Takio Packet 003.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/003-runtime-neutral-library-contract.md` exactly. Treat that packet, existing source, package metadata, and tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Start by inspecting `packages/core/src/library.ts`, `packages/core/src/index.ts`, root workspace scripts, and the existing Packet 001/002 package conventions.
- Create only the new `@takio/library-contract` package, its focused tests/documentation, and strictly necessary root workspace-script changes.
- Keep `@takio/core` as the canonical owner of `LibraryItem`; do not duplicate or change its library-domain behavior.
- The contract must be runtime-neutral and asynchronous, use `null` for missing records, and expose stable driver-independent error codes.
- Do not add or import `bun:sqlite`, `Bun.*`, filesystem APIs, SQLite, SQL, migrations, database files, external dependencies, Rust, Tauri, CLI commands, or desktop code.
- Do not implement persistence. This packet defines the contract only.
- Do not make unrelated cleanup, formatting churn, package redesign, or product changes.

Required before final response:
1. Run the package check and tests:
   ```bash
   bun run --filter '@takio/library-contract' check
   bun run --filter '@takio/library-contract' test
   ```
2. Run the clean declaration gate exactly:
   ```bash
   rm -rf packages/library-contract/dist
   bun run --filter '@takio/library-contract' build
   test -f packages/library-contract/dist/index.js
   test -f packages/library-contract/dist/index.d.ts
   ```
3. Run the shared workspace gates after the clean package build:
   ```bash
   bun run check
   bun run test
   bun run build
   git diff --check
   ```
4. Review the diff for scope discipline and confirm no Bun/SQLite/Tauri implementation was added.
5. Create exactly one micro-commit with this exact message:
   ```text
   feat(storage): define runtime-neutral library contract
   ```
6. Respond with the exported contract, stable error codes, clean-declaration evidence, complete verification output, scoped file list, commit SHA, deferred runtime decisions, and every skipped check or blocker.

If a required command, declaration gate, contract decision, or worktree operation is blocked, stop and report the blocker. Do not broaden scope, weaken the clean declaration gate, or substitute unverified behavior.
