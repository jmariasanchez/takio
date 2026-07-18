You are the Codex implementer for Takio Packet 002.

Read and follow `docs/work-packets/002-core-declaration-build-repair.md` exactly. Treat the packet, existing source, package metadata, and tests as the complete repository guidance.

Execution boundary:
- Work only in this isolated worktree.
- Touch only the existing `@takio/core` build/declaration configuration needed by the packet and a narrowly scoped regression check if required.
- Do not change package APIs, library-domain behavior, CLI, desktop, dependencies, or unrelated workspace tooling.
- Start by inspecting current `@takio/core` scripts, TypeScript configuration, package exports/types fields, and ignored build output.

Required before final response:
1. Delete `packages/core/dist` and prove a clean core build emits the declared type entrypoint.
2. Run `bun run check`, `bun run test`, and `bun run build` from the workspace root after the clean rebuild.
3. Review the diff for scope discipline.
4. Create exactly one micro commit with this exact message: `fix(core): emit package declarations`.
5. Respond with changed build contract, clean-build evidence, full verification results, commit SHA, and deferred decisions.

If blocked, stop and report the blocker. Do not broaden scope.
