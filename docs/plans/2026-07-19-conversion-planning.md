# Takio Conversion Planning Milestone — Capability-Aware Planner

> Read-only planning artifact produced with `claude-fable-5` on 2026-07-19. Nothing in this document has been implemented or committed.

**Goal:** Make `planConversion` honest. Today it plans against a hardcoded local device that claims every catalogue output, so `takio plan` "succeeds" for conversions nothing can perform. After this milestone the planner matches **input → output capability pairs** on an `ExecutionTarget` and fails truthfully when no capability has been declared. This is a pure planning milestone: it changes what a plan *means*, not what executes.

## Scope boundary against `2026-07-19-local-conversion.md`

The two 2026-07-19 plans split Horizon 2's opening cleanly and must not overlap:

- **This plan (planning only):** the capability-pair model, the `Device` → `ExecutionTarget` rename, deletion of the overclaiming `localDevice`, and honest no-capability behavior in `takio plan` / `takio devices`.
- **`docs/plans/2026-07-19-local-conversion.md` (execution), deferred wholesale from here:** adapter/backend discovery, process spawning, filesystem validation, timeouts, output paths, artifacts, checksums, execution result types, and the `takio convert` command. None of these are designed in this document.

Deliberately, **no `ConverterAdapter` interface and no execution result types are defined here.** An execution contract with no implementation in the same milestone is speculative abstraction; the contract belongs next to its first implementation, in the local-conversion plan. This plan ships only types that are consumed by code in this plan.

## Current state (exact files and behavior)

- `packages/core/src/planner.ts` — `deviceSchema` (lines 7–12) defines `Device` as `{ id, name, supportedOutputs: FormatId[] (min 1), status: "online" | "offline" }`: an **output-only** capability claim. `planConversion` parses with zod, detects the input format from the file-name string only (`detectFormat` in `packages/core/src/formats.ts` matches extensions and never touches the filesystem), and rejects exactly three cases: unknown input extension, identical input/output format, and no online device whose `supportedOutputs` includes the requested output. It returns an in-memory `PlannedJob` (`status: "planned"`, random `job_<uuid>` id, `assignedDevice`). `localDevice` (lines 72–77) hardcodes `supportedOutputs: [...FORMAT_IDS]` — all eight formats — a claim no installed capability backs.
- `packages/core/src/index.ts` — re-exports `PlanningError`, `conversionRequestSchema`, `deviceSchema`, `localDevice`, `planConversion`, and the `ConversionRequest` / `Device` / `PlannedJob` types.
- `packages/core/src/formats.ts` — eight-format catalogue (`epub, pdf, mobi, azw3, docx, html, txt, cbz`) with extension-based `detectFormat`. Untouched by this plan.
- `packages/core/src/destinations.ts` — `Destination` is a **passive mounted transfer target** (USB volume) with pure helpers, consumed by `apps/cli/src/destinations.ts` behind the hardened single-line JSON protocol. It is a different concept from the planner's `Device` and is untouched by this plan.
- `apps/cli/src/main.ts` — the only consumer of the planner exports. `takio devices` (lines 173–181) prints a one-row table of `localDevice` with an `OUTPUTS` column; `takio plan` (lines 685–712) calls `planConversion({ input, outputFormat, devices: [localDevice] })`, performs **no file stat** (`takio plan --input ghost.epub --to pdf` succeeds on a nonexistent file), reports errors via `program.error(message, { exitCode: 2 })`, and ends its human output with "status: planned (no converter adapter is configured yet)".
- Tests — `packages/core/test/planner.test.ts` (three cases, all importing `localDevice`) covers format detection, the unknown-extension rejection, and the no-online-device rejection; `apps/cli/test/main.test.ts` covers the `plan` happy path ("Planned job_…", which passes only because of `localDevice`'s overclaim) and preserved top-level Commander diagnostics for `plan` without options.
- `apps/desktop` imports only `FORMAT_CATALOG`, `LibraryItem`, and `normalizeTags` from `@takio/core` (verified by grep) — it is unaffected by any planner change.
- **No execution surface exists anywhere in the workspace:** no adapter type, no `convert` command, no queue, no job persistence.
- Verification scripts (root `package.json`): `bun run check`, `bun run test`, `bun run build`, per-package `bun run --filter '@takio/core' test` / `--filter '@takio/cli' test`, CLI entry `bun run takio …`.

## Explicit assumptions

1. **After this milestone, no concrete capability provider exists in the tree.** Stock `takio plan` therefore always fails, honestly, naming the requested pair. That is the intended truthful state — the workspace genuinely cannot convert anything — until the local-conversion milestone wires real capability in.
2. Private workspace with no external consumers of `@takio/core`, so the rename ships without a deprecated alias or re-export shim.
3. The user-facing command name `takio devices` is a README-documented agent contract and does **not** change; only TypeScript identifiers change.
4. No new dependencies. `zod` and `commander` (already installed) cover everything this plan touches.
5. This plan and `2026-07-19-local-conversion.md` are each implementable against today's tree in either order; whichever lands second performs the reconciliation in the handoff section, and the pair shape wins in either order.

## Conflicts and chosen resolutions (one resolution each, no averaging)

1. **`localDevice` claims every output vs. honest capability.** Resolution: delete the constant. `takio plan` succeeding for conversions nothing can perform is the bug this milestone fixes, not a contract to preserve. The resulting stock-checkout behavior change (`plan` now exits 2) is deliberate and flagged loudly below.
2. **Output-only matching vs. pair capability.** `supportedOutputs: FormatId[]` cannot express "can produce PDF from EPUB but not from CBZ". Resolution: capability becomes the pair `{ from: FormatId, to: FormatId }` and `supportedOutputs` is **removed**, not kept alongside — coexisting shapes would be exactly the blended-pattern state these rules forbid.
3. **When `Device` becomes `ExecutionTarget`.** The 2026-07-18 device-detection plan deferred the rename "until the conversion milestone"; `2026-07-19-local-conversion.md`'s non-goals defer it further, "to the queue milestone". These conflict. Resolution: **the rename happens here, in Phase 1, atomically with the capability-shape change**, because the pair change already breaks the exact same consumer set (`deviceSchema`, `localDevice`, `conversionRequestSchema.devices`, `PlannedJob.assignedDevice`, the CLI `devices`/`plan` actions, both test files) — one coordinated break, each call site touched once, instead of two breaks touching the same lines twice. The local-conversion plan's deferral line is superseded and flagged in the handoff.
4. **Three concepts, three names.** `Destination` (passive mounted transfer target) is untouched. The Horizon-4 remote device agent stays deferred; nothing here adds protocol, daemon, or auth surface. `ExecutionTarget` is the only renamed concept, and it names what the planner actually matches against.
5. **The previous draft of this document defined `ConverterAdapter`, execution request/result types, a Calibre adapter, and `takio convert` here.** That overlapped the local-conversion plan and would have shipped an interface with zero implementations in this milestone. Resolution: removed wholesale from this document; every execution concern is owned by `2026-07-19-local-conversion.md`.
6. **Capability representation: provider interface/registry vs. plain data.** Resolution: plain data, decided below. No interface may exist in this milestone without a concrete consumer in this milestone.

## Design decision: a pair type on the target, nothing more

The pure milestone needs exactly one small type and no helpers:

- `ConversionCapability = { from: FormatId, to: FormatId }` — a zod object built from the existing `formatSchema`, exported because three in-milestone consumers need it by name: `executionTargetSchema`, the CLI's injectable parameter, and both test files.
- Capability is represented **directly on `ExecutionTarget`** as `capabilities: ConversionCapability[]`, which **may be empty** (the current `.min(1)` is dropped): an online machine with nothing configured is a truthful state, and forcing a minimum claim is how today's lie was encoded.
- **No** provider interface, **no** `executionTargetFromAdapters`-style helper, **no** registry: the old draft's helper existed only to consume the adapter type that no longer lives here. The "capability provider" concept needs no type — a provider is simply whichever code constructs an `ExecutionTarget` with non-empty `capabilities` (the local-conversion plan's CLI wiring will be the first).

## Phases (strict; the workspace is green after each phase)

### Phase 1 — Capability-pair planner and `ExecutionTarget` rename (one atomic change, core + CLI)

**Files (modify only, nothing created, nothing else touched):**

- `packages/core/src/planner.ts`
- `packages/core/src/index.ts`
- `packages/core/test/planner.test.ts`
- `apps/cli/src/main.ts`
- `apps/cli/test/main.test.ts`

The rename breaks CLI compilation, so core and its exact CLI callers move in the same change — splitting them would leave the workspace red between phases, which is prohibited.

**`packages/core/src/planner.ts`:**

- Add `conversionCapabilitySchema = z.object({ from: formatSchema, to: formatSchema })` and `type ConversionCapability`.
- `deviceSchema` → `executionTargetSchema`: `{ id, name, capabilities: z.array(conversionCapabilitySchema), status: z.enum(["online", "offline"]) }` (no minimum on `capabilities`); `type Device` → `type ExecutionTarget`.
- `conversionRequestSchema.devices` → `targets` (same default `[]`); `PlannedJob.assignedDevice` → `assignedTarget: Pick<ExecutionTarget, "id" | "name">`.
- Matching rule: a target qualifies when `status === "online"` **and** it has a capability with `from === inputFormat && to === outputFormat`. The no-match error names the pair: `` `No online execution target can convert ${inputFormat.toUpperCase()} → ${outputFormat.toUpperCase()}.` `` — deliberately with no install hint: which backend could satisfy the pair is knowledge owned by the local-conversion plan.
- **Delete `localDevice`.**
- Unchanged: `PlanningError`, the three-rejection structure and order, the `job_<uuid>` id, and purity — `planConversion` still performs no filesystem access of any kind.

**`packages/core/src/index.ts`:** export `conversionCapabilitySchema`, `executionTargetSchema`, `type ConversionCapability`, `type ExecutionTarget`; remove `deviceSchema`, `localDevice`, `type Device`. Match the existing grouped-export style.

**`apps/cli/src/main.ts` (exact callers):**

- `createProgram` gains one trailing injectable parameter, following its existing injection pattern (`write`, `writeError`, `launch`, `eject`, `platform`): `localCapabilities: readonly ConversionCapability[] = []`. Its concrete consumers land in this same phase (the CLI tests below); it is also the exact seam the local-conversion plan wires later.
- Build the local target inline once: `{ id: "local", name: "This Mac", capabilities: [...localCapabilities], status: "online" }` — the machine-specific claim moves out of core, and by default it truthfully claims nothing.
- `takio devices`: same legacy table style (surgical scope — the JSON-protocol migration for legacy commands remains a Horizon-3 item), with the `OUTPUTS` column becoming `CONVERSIONS`, rendering pairs as `epub→pdf` comma-joined, or `(none)` when empty.
- `takio plan`: pass `targets: [localTarget]`; the human output's `device:` line becomes `target:`; the closing line becomes `status: planned (planning only; execution is a separate step)` — truthful whether or not a capability is configured, unlike the current copy. Error path unchanged (`program.error`, exit 2). `--json` now emits `assignedTarget` instead of `assignedDevice` — a documented contract change for agents, recorded in Phase 2.
- **Deliberate, loud behavior change:** on a stock checkout `takio plan` now exits 2 with the pair-naming error. The previous unconditional success was the dishonest state; this is the fix, not a regression.

**Tests that encode WHY:**

`packages/core/test/planner.test.ts` (rewritten; tests construct their own targets since `localDevice` is gone):

- A target whose only capability is `epub→pdf` is **not** selected for `mobi → pdf`, and the error names `MOBI → PDF` — encodes that capability is a pair; output-only matching is the lie this milestone removes. This test fails against today's planner, proving it encodes the new intent.
- With a capable online target, `planConversion` plans a path that need not exist on disk and returns `assignedTarget` — encodes the pure-planning boundary: planning validates the request; filesystem truth belongs to the local-conversion plan's `convert`.
- An **online** target with `capabilities: []` yields the no-capable-target error — encodes the honesty rule that killed `localDevice`: no declared capability, no plan.
- An offline target with a matching pair is not selected — encodes that liveness still gates, capability alone is insufficient.
- The unknown-extension and same-format rejections are preserved — encodes that the request-coherence checks are independent of the capability model.

`apps/cli/test/main.test.ts`:

- Default `createProgram()` (no injected capabilities): `plan --input book.epub --to pdf` exits 2 and the message names `EPUB → PDF` — encodes that a stock checkout tells agents the truth instead of fabricating a plan. This replaces the current happy-path test, whose success depended on the overclaim.
- `createProgram` with `[{ from: "epub", to: "pdf" }]` injected: the same invocation prints `Planned job_…` — encodes that the injection seam is real and sufficient, so the local-conversion plan can make planning truthful-positive without further core changes.
- `takio devices` prints `(none)` by default and `epub→pdf` with the injected pair — encodes that the device listing is a truthful capability inventory, not a static claim.
- The existing "preserves invalid top-level plan diagnostics" process test is unchanged.

**Green check:** full workspace (`bun run check && bun run test && bun run build`) after this single phase.

### Phase 2 — Documentation truth-up (docs only)

**Files:** `README.md`, `docs/architecture.md`. No code.

- `README.md`: update "Current milestone" (planner is capability-pair aware; stock `plan` fails honestly until the local-conversion milestone configures capability); CLI contract table — `takio devices` row becomes "Lists execution targets and their configured conversion pairs"; note under the table that `plan --json` now reports `assignedTarget` and that a plan is still not execution.
- `docs/architecture.md`: `@takio/core` row responsibility becomes "…capability-pair planning"; add one sentence recording that the planner's `Device` is now `ExecutionTarget` while `Destination` remains the passive mounted transfer target; amend execution-roadmap step 1 to state that capability declaration now lives on `ExecutionTarget` (done) and that the converter execution contract will be defined **together with its first implementation** in the local-conversion plan — never as an unimplemented interface.
- Touch nothing else in either file.

**Green check:** `git diff --check`; `bun run test` unaffected.

## Exact runnable verification

```sh
bun install
bun run check
bun run --filter '@takio/core' test
bun run --filter '@takio/cli' test
bun run test
bun run build

# Honest stock behavior (expected: exit 2, error naming the pair, no fabricated plan)
bun run takio plan --input ~/Books/example.epub --to pdf; echo "exit=$?"
bun run takio devices          # expected: local target listed with CONVERSIONS = (none)

# Rename hygiene (expected: no matches)
grep -rn "localDevice\|supportedOutputs\|assignedDevice\|deviceSchema" packages/core/src apps/cli/src
```

All automated tests pass with zero skips on any machine; nothing in this plan shells out, probes for converters, or touches the filesystem beyond the repository.

## Non-goals

Deferred to `docs/plans/2026-07-19-local-conversion.md` (all of it, explicitly): adapter/backend discovery (env override, `PATH`, app-bundle probing); any `ConverterAdapter` or execution request/result types; process spawning, timeouts, kill semantics; filesystem validation of inputs (`plan` stays deliberately stat-free); output paths, overwrite rules, artifacts, checksums, byte counts; the `takio convert` command; fake-backend fixtures and the manual smoke gate.

Deferred to later milestones: persistent job queue, `jobs`/`cancel` (roadmap step 3); desktop conversion UI (step 4); remote device agents, pairing, auth (Horizon 4); migrating the legacy `formats`/`devices`/`plan` output style to the JSON protocol (Horizon 3 ergonomics pass).

Not done at all: renaming the user-facing `takio devices` command; new dependencies, packages, registries, queues, or persistence of any kind; touching `Destination`, `formats.ts`, the library store, or the desktop app.

## Success criteria

1. `planConversion` matches on capability pairs: a target able to produce an output from one input is never selected for another input, proven by a test that fails against today's planner.
2. On a stock checkout, `plan` exits 2 naming the pair and `devices` shows the local target with zero pairs — no code path can fabricate a plan without a declared capability.
3. Injecting a single capability through `createProgram` makes `plan` succeed, with no execution code anywhere in the workspace.
4. `bun run check`, `bun run test`, `bun run build` are green with zero skipped tests; `library`/`destination`/`send` behavior is byte-identical.
5. The rename-hygiene grep is clean; `Destination` is untouched.
6. This milestone adds no interface, type, or helper without a concrete consumer inside this milestone.

## Rollback and safe disable

No schema change, migration, persisted state, config, dependency, or background process is introduced; the library SQLite store is never written by `plan` or `devices`. Phase 1 is one commit whose blast radius is exactly the five listed files — `git revert` restores the old planner verbatim. Phase 2 is docs-only and independently revertible. There is no runtime feature to disable: the milestone only changes what planning claims, and the post-milestone stock behavior *is* the safe state (honest failure).

## Dependency handoff to `docs/plans/2026-07-19-local-conversion.md`

**What that plan must consume from this milestone:**

1. **The pair shape is the only capability representation.** `ConversionCapability` from `@takio/core` replaces its Phase-1 `LOCAL_CONVERSION_OUTPUTS` output-only list, which must become a curated pair list (e.g. `LOCAL_CONVERSION_CAPABILITIES: readonly ConversionCapability[]`) so its cbz/html-output exclusions are expressed per pair and the output-only flattening this milestone removed cannot re-enter through a parallel model. Whether its `validateConversionPair` is then implemented over that pair list or replaced by calling `planConversion` with a constructed local `ExecutionTarget` is that plan's decision; the data shape is not.
2. **The renamed identifiers.** Its edits to `apps/cli/src/main.ts` will encounter `ExecutionTarget`, `assignedTarget`, and `localCapabilities`. Its non-goal line deferring "renaming planner `Device` or fixing `localDevice`'s overclaim … to the queue milestone" is superseded by this milestone and should be dropped in its next revision — both are done here.
3. **The CLI seam.** `createProgram`'s `localCapabilities` parameter is the intended wiring point for making `takio devices`/`plan` truthful-positive on machines where its backend discovery succeeds. Wiring discovered capability into that seam — or explicitly deferring the wiring with a stated reason — is that plan's obligation. Until wired, `plan` stays honest-negative even with a backend installed: truthful, merely conservative.

**Owned solely by that plan (this document must never grow into them):** backend discovery order and the `TAKIO_EBOOK_CONVERT` override; spawning, timeouts, workspace isolation; artifact validation, containment, size caps; checksums and byte counts; output-path and overwrite rules; the `takio convert` command with its JSON protocol and frozen error codes; the fake-backend fixture and the manual real-backend smoke gate; and the definition of any adapter/backend execution contract, which may appear only together with its first implementation.

## Micro-commit boundaries

1. `refactor(core): model conversion capability pairs` — Phase 1 atomically updates core, CLI callers, and their intent tests; full workspace gates green.
2. `docs: record capability-aware conversion planning` — Phase 2 only; `git diff --check` and the full test suite remain green.

**Ordering:** neither plan depends on the other landing first; both are implementable against today's tree. Whichever lands second performs the reconciliation above, and the pair shape wins in either order.
