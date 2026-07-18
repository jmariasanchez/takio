You are the strategy planner for Takio, a lightweight modern alternative to Calibre.

Produce an ABSTRACT product-delivery roadmap, not a file-by-file implementation plan. Takio is a Bun monorepo with:
- a Tauri/React desktop application for a local-first library and conversion workspace;
- a Bun CLI built for AI agents, skills, scripts, and humans;
- a shared TypeScript domain package;
- future local converter adapters, a persistent job queue, and authenticated remote device agents.

The delivery workflow will be run by OpenAI Codex CLI. Codex should implement narrowly scoped work packets in isolated worktrees. An orchestrator should sequence dependent packets, collect machine-readable evidence, request independent spec and quality reviews, and only merge verified work.

Return exactly:
1. Product pillars (3–5 bullets)
2. Delivery horizons (Foundation, Local Conversion, Unified Experience, Distributed Devices, Release Readiness)
3. For each horizon: outcomes, major capabilities, non-goals, and exit criteria
4. The Codex delegation/orchestration model: roles, work-packet boundary, review gates, evidence required, and rollback approach
5. Cross-cutting quality/security principles

Keep it concise, strategic, and abstract. Do not prescribe individual file paths, implementation snippets, or sprint dates.
