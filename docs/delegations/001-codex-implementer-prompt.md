You are the Codex implementer for Takio Packet 001.

Read and follow `docs/work-packets/001-shared-library-domain.md` exactly. Also follow repository guidance in `.codex/AGENTS.md`.

Execution boundary:
- Work only in this isolated worktree.
- Touch only `packages/core` implementation and tests required by the packet.
- Do not modify the packet, roadmap, CLI, desktop, dependencies, workspace tooling, or existing conversion-planning behavior.
- Inspect the existing core exports and tests before writing code.
- Use test-first development where practical.

Required before final response:
1. Run the packet-local check and test commands.
2. Run `bun run check` and `bun run test` from the repository root.
3. Review your diff for scope discipline.
4. Create exactly one micro commit with this exact message: `feat(core): add shared library domain`.
5. Respond with: changed public contract, verification transcripts/results, commit SHA, deferred decisions, and any unverified assumptions.

If a requirement is unclear or blocked, stop and report the blocker. Do not broaden scope or make speculative additions.
