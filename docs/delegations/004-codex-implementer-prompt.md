You are the Codex implementer for Takio Packet 004.

You are already running in a fresh isolated Git worktree under an orchestrator-managed `codex exec` invocation with model `gpt-5.6-sol`, high reasoning effort, and workspace-write sandboxing. Do not invoke `codex`, attempt to start another Codex app-server client, or preflight the CLI from inside this session.

Read and follow `docs/work-packets/004-library-contract-clean-build-repair.md` exactly. Treat that packet, existing package metadata, TypeScript configuration, source, and tests as the complete repository guidance.

Execution boundary:
- Work only in the assigned isolated worktree.
- Start by inspecting `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/library-contract/package.json`, `packages/library-contract/tsconfig.json`, and root workspace scripts.
- Make only the smallest deterministic build-orchestration repair required for a clean standalone `@takio/library-contract` build.
- Prefer a package-local repair. Do not change root workspace scripts unless the package-local repair is demonstrably insufficient; report a blocker rather than broadening scope.
- Do not change runtime behavior, public APIs, contract semantics, domain code, application source, dependencies, lockfiles, package versions, or TypeScript architecture.
- Do not add Bun runtime code, SQLite, filesystem persistence, SQL, migrations, database files, CLI behavior, Tauri/Rust code, or desktop changes.
- Do not make unrelated cleanup or formatting changes.

Required before final response:
1. Delete both relevant ignored build-artifact directories and run the standalone contract build exactly:
   ```bash
   rm -rf packages/core/dist packages/library-contract/dist
   bun run --filter '@takio/library-contract' build
   test -f packages/core/dist/index.js
   test -f packages/core/dist/index.d.ts
   test -f packages/library-contract/dist/index.js
   test -f packages/library-contract/dist/index.d.ts
   ```
2. Run the complete workspace gates after that clean standalone build:
   ```bash
   bun run check
   bun run test
   bun run build
   git diff --check
   ```
3. Review the diff and explain why it is the smallest build-orchestration repair. Confirm explicitly that no runtime/API/dependency/SQLite/Tauri change was made.
4. Create exactly one micro-commit with this exact message:
   ```text
   fix(build): restore contract clean build
   ```
5. Respond with the clean-build transcript, generated-file evidence, complete workspace-gate output, scoped file list, commit SHA, explanation of the repair, and every skipped check or blocker.

If clean compilation, declaration generation, package-local scope, or a required worktree operation is blocked, stop and report the blocker. Do not weaken the clean-build gate or substitute unverified behavior.
