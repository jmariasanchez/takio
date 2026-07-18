# Takio Bun + Tauri Foundation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Establish Takio as a Bun monorepo with a native minimalist desktop application and an agent-first CLI.

**Architecture:** `@takio/core` is the shared domain layer. `@takio/cli` exposes deterministic format, device, and planning commands for skills and AI agents. `@takio/desktop` is a Tauri v2 shell containing a React interface; it will later call the same controller/queue behind the CLI.

**Tech Stack:** Bun 1.3+, TypeScript, Tauri v2, Rust, React 19, Vite, Bun test.

---

### Task 1: Migrate the workspace to Bun

**Objective:** Remove pnpm-specific workspace metadata and make Bun the package manager and task runner.

**Files:**
- Modify: `package.json`
- Modify: `apps/cli/package.json`
- Modify: `packages/core/package.json`
- Delete: `pnpm-lock.yaml`
- Delete: `pnpm-workspace.yaml`
- Create: `bun.lock`

**Verification:** `bun install`, `bun run check`, and `bun run test` complete successfully.

### Task 2: Preserve a machine-friendly CLI contract

**Objective:** Keep the CLI usable from skills and agents while conversion execution is not yet available.

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/test/main.test.ts`

**Verification:** `bun run takio formats --json` and `bun run takio plan --input sample.epub --to pdf --json` return valid structured data.

### Task 3: Add the Tauri desktop shell

**Objective:** Provide a native application host for the future Takio library and conversion queue.

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`

**Verification:** With Rust/Cargo installed, `bun run desktop` opens a native Takio window.

### Task 4: Build the minimalist desktop interface

**Objective:** Build a calm, conversion-first desktop layout rather than duplicating Calibre's dense library UI.

**Files:**
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/styles.css`
- Create: `apps/desktop/src/lib/format.ts`
- Create: `apps/desktop/src/lib/format.test.ts`

**Verification:** `bun run --filter @takio/desktop build` and `bun run --filter @takio/desktop test` pass. The file picker and plan affordance work once launched through Tauri.

### Task 5: Connect real conversion execution

**Objective:** Implement adapters, a local queue, then authenticated remote device agents.

**Files:** To be designed after choosing an initial conversion backend.

**Verification:** A successful `takio convert ... --json` result includes artifact path, digest, selected device, and terminal job status.
