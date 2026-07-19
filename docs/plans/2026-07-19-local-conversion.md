# Takio Local Conversion Plan

> Drafted with `claude-fable-5` on 2026-07-19. Its dependency handoff was aligned to the later Fable-generated capability-planning correction; a fresh Fable alignment pass was unavailable because the Claude session reset gate had been reached.

**Goal:** The first real local conversion execution: a synchronous `takio convert` that runs Calibre's `ebook-convert` as a child process, validates the artifact, and reports truthful terminal state. This is the first step of a strict waterfall and lands before any persistent job queue.

## Waterfall position

This plan is Horizon 2's execution slice (`docs/roadmaps/claude-fable-5-product-roadmap.md`). It starts only after `docs/plans/2026-07-19-conversion-planning.md` lands, and consumes that milestone's capability-pair planner and `ExecutionTarget` names. Nothing here persists jobs. The queue, progress, retry, cancellation, desktop wiring, and library-artifact import all depend on this slice existing first and are out of scope.

## Current state (grounded)

- Before the planning prerequisite lands, `packages/core/src/planner.ts` returns an **in-memory** `PlannedJob` and the hardcoded `localDevice` overclaims all eight outputs. The prerequisite removes that lie, renames the concept to `ExecutionTarget`, and makes `ConversionCapability { from, to }` the only capability shape. This plan must be implemented against that landed shape, not against the pre-milestone names recorded here.
- `apps/cli/src/main.ts` — the `plan` command prints `status: planned (no converter adapter is configured yet)` and uses the **legacy** protocol: prose, pretty-printed JSON, exit 2 via `program.error`.
- The **newer hardened protocol** (library/destination commands, enforced by `apps/cli/test/main.test.ts` and `apps/cli/test/destinations.test.ts`): exactly one physical JSON line on stdout, `{ok:true,value:…}` / `{ok:false,error:{code}}`, kebab-case codes, nonzero exit on failure, empty stderr, no Commander prose (`storageCommand` + `exitOverride`).
- `apps/cli/src/destinations.ts` — established execution-safety patterns to reuse: `Bun.spawn` with argument arrays only, streaming SHA-256 (`hashFile`), partial-file-then-`rename` finalization, `fsync` helpers, realpath containment checks, and the `destination-test-seam.ts` injection pattern.
- `apps/cli/src/main.ts` `library import` — temp-copy-then-rename with cleanup limited to invocation-created files.
- `packages/library-contract` — `{ok,value}|{ok,error:{code}}` result convention with frozen code lists.
- `packages/core/src/formats.ts` — eight-format catalog and extension-based `detectFormat`.
- No converter adapter, queue, or `convert` command exists anywhere in the repository.

## Backend decision and evidence resolution

Machine evidence gathered 2026-07-19 on this Mac (Darwin 24.6.0, Bun 1.3.13):

- `command -v ebook-convert pandoc libreoffice soffice` → none found on `PATH`.
- `/usr/bin/textutil` exists (converts txt/rtf/html/docx only).
- **`/Applications/calibre.app` is installed**, and `/Applications/calibre.app/Contents/MacOS/ebook-convert --version` reports `calibre 9.9.0`.

**Resolution (no averaging):**

1. **The only backend is `ebook-convert`**, exactly as `docs/architecture.md` directs ("Start with Calibre's ebook-convert only as a backend"). It is the only discovered tool that covers ebook targets (`epub`, `mobi`, `azw3`).
2. **`textutil` is not a fallback.** It cannot produce any ebook format, and a second engine would fork conversion semantics per pair before the first engine works. No fallback backend is invented.
3. **The "no ebook-convert" premise is refined, not accepted.** `PATH` lookup alone would report the backend unavailable on this machine even though a working binary exists in the app bundle. Discovery therefore checks, in order: the `TAKIO_EBOOK_CONVERT` environment override, `PATH` (`Bun.which`), then the fixed macOS bundle path `/Applications/calibre.app/Contents/MacOS/ebook-convert`. No other paths are probed.
4. **Automated tests never touch real calibre.** All CI coverage runs against an injected fake backend executable. The real-backend smoke check is a **manual gate**: it has not been run, stays blocked for any `PATH`-based invocation on this machine, and becomes runnable here only through the env override or bundle-path discovery. Phase 4 records its result explicitly; until then no claim of real-backend success is made.

## Explicit assumptions

1. Development and manual verification are macOS-only; discovery's bundle probe is Darwin-gated. Linux/Windows discovery is deferred.
2. `Bun.spawn` in Bun 1.3.13 supports the `timeout`/`killSignal` options. Verify at implementation start; if absent, use a manual timer plus `kill()` — no new dependency either way.
3. `ebook-convert` selects the output format from the output file's extension, so the workspace artifact is always named `output.<canonical extension>`.
4. Synchronous foreground execution is acceptable pre-queue: the CLI process's lifetime is the job's lifetime. If the user kills the CLI, the child may survive briefly and only an orphan temp workspace can remain (safe to delete; never reported as success).
5. `--output` is an explicit required path. Before the queue/library owns artifacts, Takio does not invent an artifact location and does not import artifacts into the library.
6. No new third-party library. `commander`, `@takio/core`, `bun:test`, `Bun.spawn`/`Bun.which`, `node:fs/promises`, `node:path`, `node:os`, and `node:crypto` (all present) cover every need.
7. The conversion-planning milestone has landed. If its exported surface differs from its plan, re-ground this document against the implementation before writing code.

## Conflicts surfaced (not blended)

- **The pre-milestone `localDevice` overclaim is resolved upstream.** This slice must not recreate it through an output-only list. Its backend declaration is a curated `ConversionCapability[]`, shared by `convert` validation and the planner's `localCapabilities` seam.
- **Two CLI protocols coexist.** `formats`/`devices`/`plan` use the legacy prose/exit-2 pattern; library/destination commands use the hardened single-line JSON protocol. `convert` adopts the newer, test-hardened protocol. The legacy commands stay byte-identical; the divergence remains deliberate and documented, as in the device-detection plan.
- **Planning and execution stay distinct but share one capability truth.** `convert` performs filesystem preflight and execution itself, while its pure pair validator searches the same `ConversionCapability[]` supplied to `createProgram`. It does not introduce a parallel output-only model or claim that a plan is execution.

## Frozen contract

Pure capability domain in `@takio/core` (shape only; final code is implementation work):

```ts
export const LOCAL_CONVERSION_BACKEND = "ebook-convert";
// Outputs the backend documents AND Takio is willing to claim. cbz output is
// impossible; html output is excluded pending real-backend evidence.
export const LOCAL_CONVERSION_CAPABILITIES: readonly ConversionCapability[];

export type ConversionPairValidation =
  | { ok: true; inputFormat: FormatId }
  | { ok: false; code: "unknown-input-format" | "same-format" | "unsupported-output" };

export function validateConversionPair(inputFileName: string, outputFormat: FormatId): ConversionPairValidation;
```

CLI success — exactly one physical line on stdout, exit 0, empty stderr:

```json
{"ok":true,"value":{"job":{"id":"job_<uuid>","backend":"ebook-convert","inputFormat":"epub","outputFormat":"pdf","status":"completed","artifact":{"path":"/abs/out.pdf","bytes":12345,"sha256":"<hex>"}}}}
```

`status:"completed"` is emitted only after the child process exited 0 **and** the artifact passed validation **and** the verified bytes were renamed into place. There is no intermediate status in this slice.

CLI failure — one line, exit 1: `{"ok":false,"error":{"code":"<code>"}}`, with an optional `detail` field (stderr tail, ≤200 chars, control characters stripped) **only** for `conversion-failed` and `conversion-timeout`. This is an additive extension of the error shape for the new command only; existing commands are untouched.

Error codes (frozen): `invalid-arguments`, `backend-unavailable`, `source-unavailable`, `unsupported-conversion`, `output-file-exists`, `conversion-failed`, `conversion-timeout`, `artifact-invalid`, `copy-failed`.

## Phase 1 — Pure conversion capability domain in `@takio/core`

**Depends on:** the completed conversion-planning milestone.

**Files:** create `packages/core/src/conversion.ts`, `packages/core/test/conversion.test.ts`; modify `packages/core/src/index.ts` (re-export only).

**Behavior:** the frozen contract above. Pure functions, no filesystem or process access (matching the `destinations.ts` core precedent). `LOCAL_CONVERSION_CAPABILITIES` explicitly enumerates supported input/output pairs using the planner's `ConversionCapability` type. `validateConversionPair` reuses `detectFormat` and rejects unknown input extensions, identical input/output formats, and pairs absent from that list.

**Tests that encode intent:** `cbz` and `html` as outputs are rejected *because* no evidence exists that the backend produces them — the test comment names the evidence rule so a future pair addition must bring proof; only explicitly listed input/output pairs pass; same-format requests fail because a copy is not a conversion; the validator never throws, so callers cannot skip a branch.

## Phase 2 — Backend discovery and request preflight (internal, no CLI surface)

**Depends on:** Phase 1.

**Files:** create `apps/cli/src/convert.ts`, `apps/cli/test/convert.test.ts`; modify `apps/cli/src/destinations.ts` only to `export` the existing `hashFile`, `syncFile`, and `syncDirectory` helpers for reuse (no behavior change).

**Behavior:**

- `discoverEbookConvert(env, platform)`: `TAKIO_EBOOK_CONVERT` override (empty string → `invalid-arguments`, matching the `TAKIO_DATA_DIR` precedent; set-but-unusable → `backend-unavailable`) → `Bun.which("ebook-convert")` → on Darwin the fixed bundle path. A candidate qualifies only if it is an existing regular file with execute permission (`access` + `X_OK`). Returns the absolute path or `null`. The probe list is injectable so tests are hermetic and never depend on this machine's real calibre install.
- Input preflight: `realpath` the source; it must be a nonempty regular readable file (`source-unavailable` for missing/non-file/unreadable; `invalid-arguments` for empty). Pair validation via `validateConversionPair` (`unsupported-conversion` on failure). The backend is never spawned by this phase.
- Output preflight: resolve `--output`; its extension must be a declared extension of the target format (because the backend keys on extension — mismatch is `invalid-arguments`); its parent directory must already exist; a preexisting target without `--overwrite` is `output-file-exists`; a preexisting target that is not a regular file is `invalid-arguments` even with `--overwrite`.
- No command registration yet: after this phase the repository still truthfully says conversion is unavailable.

**Tests that encode intent:** discovery ignores `PATH` when the override is set (agents pin backends deterministically); an unusable override fails as `backend-unavailable` rather than silently falling through to a different binary (never execute something other than what the caller pinned); extension/format mismatch is rejected *because* the backend infers format from the extension; every preflight failure occurs before any process could spawn.

## Phase 3 — Execute, validate, finalize: `takio convert` (terminal slice)

**Depends on:** Phase 2.

**Files:** modify `apps/cli/src/convert.ts`, `apps/cli/src/main.ts` (register `convert` as a `storageCommand` and supply `LOCAL_CONVERSION_CAPABILITIES` through the existing `localCapabilities` seam only when backend discovery succeeds), `apps/cli/test/convert.test.ts`; create `apps/cli/test/fixtures/fake-ebook-convert.ts` (committed executable Bun script; behavior selected by `FAKE_EBOOK_CONVERT_MODE`: copy-input, exit-nonzero, sleep, write-empty, write-symlink, write-nothing).

**Command:** `takio convert --input <path> --to <format> --output <path> [--overwrite] [--timeout-seconds <n>]` (default timeout 300 s; must be a positive integer). JSON-only, hardened protocol.

**Execution order (all of it required):**

1. Run Phase 2 preflight (backend, source, pair, output). Fail fast before spending conversion time.
2. Create an isolated workspace with `mkdtemp(join(tmpdir(), "takio-convert-"))`; the artifact target is `<workspace>/output.<canonical extension>`.
3. Spawn with an argument array only — `Bun.spawn([backendPath, canonicalInput, artifactPath], { cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout, killSignal: "SIGKILL" })`. Never a shell string. Drain stdout and stderr concurrently, retaining at most 64 KiB each (draining is mandatory so a chatty backend cannot deadlock on pipe backpressure); excess is discarded.
4. Timeout kill → `conversion-timeout`. Nonzero exit or death by signal → `conversion-failed` (+ sanitized `detail`). A spawn failure (e.g. binary vanished) → `backend-unavailable`.
5. Artifact validation, treating the backend's output as untrusted: `lstat` the artifact — it must exist, be a regular file (a symlink is rejected), be nonempty, and not exceed the size cap (constant, 4 GiB — the time limit is enforced live by the kill; the size limit is enforced post-hoc at validation, and live disk-quota enforcement is deferred until evidence requires that separate hardening); its `realpath` must remain contained in the workspace `realpath`. Any violation → `artifact-invalid`, and the requested output path is never created.
6. Finalize using the destination-transfer pattern: `copyFile` the artifact to `<output>.tmp-<uuid>` beside the final path (partial-in-target-directory avoids cross-device `rename`), hash the **partial** with the reused `hashFile` (the reported `bytes`/`sha256` are computed from the bytes that get renamed, not from the workspace copy), re-check the collision rule, `syncFile` the partial, `rename` to the final path, `syncDirectory` the parent. Any I/O failure → `copy-failed`.
7. Emit the frozen success line; exit 0.
8. `finally`: best-effort `rm` of the workspace (recursive, force) and, when not renamed, the partial. Never delete the user's input or any preexisting output file.

**Tests that encode intent (all via the fake backend; process-level tests reuse the existing `invokeProcess` pattern with `TAKIO_EBOOK_CONVERT` and an overridden `TMPDIR`):**

- End-to-end success: JSON `bytes`/`sha256` match an independently computed hash of the final file; the overridden `TMPDIR` contains no `takio-convert-*` leftovers — completion means verified artifact *and* clean workspace.
- Nonzero-exit, write-nothing, write-empty, and write-symlink modes each fail with their documented code and create **no** file at the requested output path — the output path materializes only for verified success, so a watcher can never observe a lie.
- Sleep mode with `--timeout-seconds 1` → `conversion-timeout`; the fake's post-sleep marker file is absent, proving the child was actually killed, not abandoned.
- Collision without `--overwrite` fails **before** the backend runs (the fake records invocation via a marker) — Takio does not burn minutes of conversion it will refuse to deliver; `--overwrite` replaces content and still verifies.
- `epub → cbz` → `unsupported-conversion` with the backend never invoked.
- Every failure is exactly one physical JSON line, empty stderr, exit 1 — asserted with the same strictness as the library protocol tests.
- With a discovered fake backend, `devices` exposes exactly the curated pairs and `plan` accepts one of them; with no discovered backend both remain honest-negative — capability advertisement and executable availability cannot diverge.

## Phase 4 — Documentation and the manual real-backend smoke gate

**Depends on:** Phase 3.

**Files:** modify `docs/architecture.md` (converter-adapter row → "Implemented: local ebook-convert, synchronous", plus one sentence on discovery order), `README.md` (add `takio convert` to the CLI contract table; correct the "Converter adapters … are the next milestone" sentence). Touch nothing unrelated.

- Run the manual smoke check below on this machine via the bundle path, and record the command, calibre version, and artifact SHA-256 in the commit message.
- If the smoke check fails, the docs change does not land and the failure is reported verbatim — the feature remains shipped-but-flagged, not silently blessed.

## Trust boundaries and security summary

Untrusted: `--input`/`--output` values, source file contents, the `TAKIO_EBOOK_CONVERT` value, and everything the backend writes or prints. Controls: argument-array spawning only; isolated per-invocation `mkdtemp` workspace with `cwd` pinned; live timeout with `SIGKILL`; capped stream capture; post-hoc artifact size cap; symlink-rejecting, containment-checked, nonempty regular-file artifact validation; digest-and-byte-count reporting from the finalized bytes; partial-then-rename with fsync; cleanup limited to invocation-created files. No network, daemon, credential, or persistent state is added.

## Exact runnable verification

```sh
bun install
bun run --filter '@takio/core' check && bun run --filter '@takio/core' test   # after Phase 1
bun run --filter '@takio/cli' check && bun run --filter '@takio/cli' test     # after Phases 2–3
bun run check
bun run test
bun run build
git diff --check

# Fake-process end-to-end (no calibre required; CI-equivalent)
printf 'hello takio' > /tmp/takio-in.txt
FAKE_EBOOK_CONVERT_MODE=copy-input \
TAKIO_EBOOK_CONVERT="$PWD/apps/cli/test/fixtures/fake-ebook-convert.ts" \
  bun run takio convert --input /tmp/takio-in.txt --to epub --output /tmp/takio-out.epub
shasum -a 256 /tmp/takio-out.epub   # must match the sha256 in the JSON line

# MANUAL SMOKE GATE — real backend. NOT RUN YET; blocked for any PATH-based
# invocation on this machine (command -v finds no ebook-convert). Runnable here
# only via the calibre.app bundle binary; Phase 4 must execute and record it.
TAKIO_EBOOK_CONVERT=/Applications/calibre.app/Contents/MacOS/ebook-convert \
  bun run takio convert --input <real>.epub --to pdf --output /tmp/smoke.pdf
shasum -a 256 /tmp/smoke.pdf
```

**Skipped / manual checks, surfaced:** (1) the real `ebook-convert` smoke conversion — manual, unexecuted at planning time, gated in Phase 4; (2) per-pair real-backend verification for outputs other than `epub → pdf` — the capability table's remaining pairs are documented Calibre outputs but individually unverified locally, and stay flagged in the Phase 4 doc note; (3) the existing manual `diskutil eject` hardware check from the destination plan remains manual and unrelated; (4) desktop app behavior is untouched and only regression-covered by the existing `bun run test` suite.

## Non-goals

Persistent job queue, job IDs that outlive the process, progress/retry/cancellation, crash-resume; desktop/Tauri conversion; converting library items by ID or importing artifacts into the library; pandoc/libreoffice/textutil or any fallback backend; adapter marketplace or plugin registry; remote execution, daemons, device agents; `cbz`/`html` outputs; conversion options (covers, metadata, profiles); Linux/Windows backend discovery; any further planner or execution-target redesign beyond wiring the prerequisite's existing `localCapabilities` seam.

## Success and exit criteria

1. `takio convert` produces a digest-verified artifact via the fake backend in CI, with the frozen one-line JSON and exit 0, and zero skipped tests.
2. Every documented failure path (`backend-unavailable`, preflight, `conversion-failed`, `conversion-timeout`, `artifact-invalid`, `output-file-exists`, `copy-failed` where injectable) is test-proven to emit one JSON line, exit 1, and leave no file at the requested output path.
3. `completed` is observably unreachable without a zero child exit plus artifact validation — asserted by the write-nothing/empty/symlink/nonzero tests.
4. The manual bundle-path smoke check has been run once and its artifact hash recorded (Phase 4), or its failure is reported and the docs claim is withheld.
5. `bun run check`, `bun run test`, `bun run build` pass; existing `formats`, `devices`, `plan`, `library`, `destination`, and `send` behavior is byte-identical.

## Rollback and safe disable

Everything is additive: no schema change, no migration, no persisted state, no dependency, no background process. Safe-disable is removing the `convert` registration from `apps/cli/src/main.ts`; full rollback is reverting the commits (core exports included). A crash can leave only `takio-convert-*` directories under the OS temp dir and `.tmp-<uuid>` partials beside a requested output — both safe to delete, neither ever reported as a completed conversion. Library data is never written by this feature.

## Micro-commit boundaries (waterfall order)

1. `feat(core): add local conversion capability domain` — Phase 1 only. Verified by core check/test. Claims capability *validation*, not conversion.
2. `feat(cli): discover and preflight the local conversion backend` — Phase 2. Verified by cli check/test; `takio --help` output unchanged (no user-facing surface). Claims discovery, not conversion.
3. `feat(cli): execute verified local conversions` — Phase 3, the terminal slice and the **first commit allowed to claim conversion works**. Verified by the full cli suite plus the fake-process end-to-end commands above.
4. `docs: record local conversion contract and real-backend smoke result` — Phase 4. Verified by `git diff --check` and the recorded smoke evidence; lands only after the smoke gate has actually been run.

Each commit passes `bun run check && bun run test` independently; no commit before 3 may describe Takio as able to convert, and no commit before 4 may describe the real backend as verified.
