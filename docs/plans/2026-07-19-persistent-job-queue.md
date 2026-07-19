# Takio Persistent Job Queue Plan

> Drafted with `claude-fable-5` on 2026-07-19. Its dependency handoff was aligned to the later Fable-generated capability-planning correction; a fresh Fable alignment pass was unavailable because the Claude session reset gate had been reached.

**Goal:** The first persistent local conversion job queue: durable SQLite-backed job records, a truthful state machine, and a one-shot `takio jobs run-next` worker that executes the already-landed synchronous local conversion executor. Persistence step of a strict waterfall behind capability-aware planning and `docs/plans/2026-07-19-local-conversion.md`.

## Waterfall position and hard dependency

This plan is Horizon 2's persistence slice (`docs/roadmaps/claude-fable-5-product-roadmap.md`: "persistent job queue with enqueue, progress, retry, cancellation, and restart behavior"). It **must not start** before both the capability-aware planning milestone and the terminal local-conversion slice have landed: the queue completes a job only by delegating to that synchronous executor and persisting its validated artifact result. **Gate:** before Phase 1, verify `ConversionCapability`/`ExecutionTarget`, `packages/core/src/conversion.ts`, `apps/cli/src/convert.ts`, `apps/cli/test/fixtures/fake-ebook-convert.ts`, and a registered `convert` command exist; if they do not, this plan is blocked, full stop.

## Current state (grounded)

- `packages/core/src/planner.ts` — `planConversion` returns an **in-memory** `PlannedJob` (`status: "planned"`, `id: "job_" + crypto.randomUUID()`, device-coupled). Nothing persists or executes.
- Capability-aware planning and local conversion are **plan documents only** today. Their waterfall contracts define `ExecutionTarget`/pair capabilities, `validateConversionPair`, backend discovery, preflight, the fake backend fixture, and the convert error codes this plan reuses.
- `packages/library-store-bun/src/index.ts` — `BunSqliteLibraryStore`, the installed `bun:sqlite` precedent: `SCHEMA_VERSION` via `PRAGMA user_version` (no meta table), STRICT tables, all initialization inside one `.immediate()` transaction, nonempty version-0 and future-version databases refused with `incompatible-schema` **without mutation**, `.immediate()` for every mutation, row revalidation on read (`invalid-stored-data`), `initialization-test-seam.ts` for atomicity tests. It sets **no WAL and no busy_timeout**.
- `packages/library-contract/src/index.ts` — frozen `{ok,value} | {ok,error:{code}}` result convention and ordered `LIBRARY_STORE_ERROR_CODES`.
- `apps/cli/src/main.ts` — hardened one-line JSON protocol via `storageCommand` (+ `exitOverride`, suppressed Commander stderr): exactly one physical JSON line on stdout, kebab-case codes, nonzero exit on failure, empty stderr. `libraryPaths` resolves `--db` / `TAKIO_DATA_DIR` / platform default to `library.sqlite`. Enforced by `apps/cli/test/main.test.ts` (`invokeProcess`, `parseProcessOutput`) and `apps/cli/test/destinations.test.ts`.
- `apps/cli/src/destinations.ts` — hash/fsync/partial-then-rename/containment patterns; `hashFile`, `syncFile`, `syncDirectory` become exported during the local-conversion slice.
- `apps/desktop` — reaches storage **only** through the CLI sidecar (`src-tauri/src/library_engine.rs`), one JSON line per invocation; it never opens SQLite directly.
- Manifests: root workspaces run check/test/build in dependency order core → library-contract → library-store-bun → cli → desktop. `apps/cli/package.json` deps: `@takio/core`, `@takio/library-store-bun`, `commander`. `bun:sqlite` is a Bun builtin — no manifest change anywhere.
- Grep confirms no `jobs` table, queue, or worker exists outside docs. Entirely greenfield.

## Persistence backend (smallest viable)

**`bun:sqlite`, nothing else.** Durable + transactional + atomic multi-process claim is exactly SQLite's job; it is already the shipped precedent (`BunSqliteLibraryStore`) and a platform builtin. No ORM, no broker, no server, no daemon, no remote execution, no plugin framework, no generic scheduler — a queue for one machine and one backend needs one table and five statements. Raw SQL with zod row revalidation, matching the existing store.

One deliberate divergence from the library store: the queue database sets `PRAGMA busy_timeout = 5000` at open, because atomic claim under two concurrent connections is a hard requirement here and the default busy behavior (immediate `SQLITE_BUSY`) is not, while the library store has no such concurrency contract. The library store is untouched. WAL is **not** enabled (`ponytail:` rollback journal + busy_timeout covers a local two-process queue; WAL is the upgrade path if reader/writer contention ever measures as a problem).

## Boundary decision (chosen, not blended)

**Separate database file, no new package.**

- **`jobs.sqlite`, not `library.sqlite`.** The library schema is frozen at v2 behind a backup-then-migrate discipline and a `LibraryStoreConfig` contract that deliberately excludes schema concerns; this plan's scope forbids library schema changes and none is indispensable. A separate file gives independent migration risk, zero chance of a queue bug corrupting user library data, and trivial rollback (delete `jobs.sqlite`; library and artifacts untouched). Jobs are operational history, not user content — the recovery economics differ, so the storage should too.
- **Store module inside `apps/cli` (`apps/cli/src/job-store.ts`), not a `packages/job-queue-*` pair.** The library store earned a runtime-neutral contract package because two frontends could implement against it; repository evidence shows the desktop consumes storage exclusively through the CLI sidecar, so the queue has exactly one direct consumer. A contract package with one implementation and one caller is a speculative abstraction. This is a deliberate divergence from the library-store precedent, flagged: extract to a package if a second direct consumer ever materializes (current evidence says it will not).
- **Pure job domain in `@takio/core` (`packages/core/src/jobs.ts`)**, following the `destinations.ts`/`conversion.ts` pure-domain precedent: statuses, transition table, per-status record invariants, frozen error codes. No filesystem or process access in core.

`planConversion` remains an in-memory planning primitive and is not a persisted queue record. The queue derives its record from the local-conversion slice's pair-validated request, using the same `ConversionCapability` truth already exposed through `ExecutionTarget`; it does not recreate planner identifiers or capability rules in storage.

## Frozen contract

### Schema (`jobs.sqlite`, `PRAGMA user_version = 1`)

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                -- "job_" + crypto.randomUUID(), planner precedent
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','canceled')),
  input_path TEXT NOT NULL,           -- realpath at enqueue
  input_format TEXT NOT NULL,
  output_format TEXT NOT NULL,
  output_path TEXT NOT NULL,          -- resolved absolute at enqueue
  created_at TEXT NOT NULL,           -- ISO-8601 UTC
  started_at TEXT,
  finished_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  owner_pid INTEGER,
  error_code TEXT,
  artifact_path TEXT,
  artifact_bytes INTEGER,
  artifact_sha256 TEXT
) STRICT;
CREATE INDEX jobs_status_order ON jobs (status, created_at, id);
```

Initialization mirrors `BunSqliteLibraryStore.open` exactly: version read + nonempty-version-0 preflight + DDL + `user_version = 1` stamp inside a single `.immediate()` transaction; any nonempty version-0 or `user_version != 1` database → close and return `incompatible-schema` with the file byte-for-byte unmodified.

### State machine and transactional invariants

| From | To | Trigger | Guard |
| --- | --- | --- | --- |
| queued | running | `claim` | single-statement atomic `UPDATE … RETURNING`; sets `owner_pid`, `started_at`, `attempts + 1` |
| queued | canceled | `cancel` | sets `finished_at`; terminal |
| running | completed | `complete` | **only** after full artifact validation (below); sets `finished_at`, artifact triple, clears `owner_pid` |
| running | failed | `fail` / recovery | requires `error_code`; sets `finished_at`, clears `owner_pid`; terminal |

Every other transition (including any transition out of a terminal state, cancel of a running job, complete/fail of a non-running job) is rejected with `invalid-transition` and the row is untouched. Missing id → `unknown-job`. All guards are enforced in the SQL `WHERE` clause (`… AND status = 'queued'` etc.) so two connections cannot both win; `changes() === 0` on an existing row means `invalid-transition`, never a silent success.

- **Enqueue:** runs the convert slice's source/pair/output preflight (backend discovery excluded — the backend is a run-time concern), then inserts a `queued` row. Failure codes reuse the convert slice's frozen codes (`source-unavailable`, `unsupported-conversion`, `output-file-exists`, `invalid-arguments`).
- **Ordering:** `get` is by id; `list` and claim order strictly by `(created_at, id)` ascending — deterministic, reconstructible from visible columns, FIFO in practice with a stable tiebreak.
- **Claim (atomic under two connections):** `UPDATE jobs SET status='running', owner_pid=?, started_at=?, attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, id LIMIT 1) AND status='queued' RETURNING *` — one statement, so SQLite serializes competing claimers; busy_timeout absorbs lock contention.
- **Completion:** `complete(id, executorArtifact)` may persist `completed` **only** after revalidating the executor's claim against the filesystem: `realpath(artifact.path)` must equal the `realpath` of the job's recorded `output_path` (an escaped or relocated artifact is refused); `lstat` must show a regular non-symlink file; size must be nonzero **and** equal the reported bytes; a freshly recomputed SHA-256 (reused `hashFile`) must equal the reported digest. Any violation → the store returns `artifact-invalid`, the row stays `running`, and the worker records `fail(id, "artifact-invalid")`. A `completed` row therefore never exists without a verified artifact triple.
- **Cancellation:** queued-only. Active-process cancellation is out of scope; `cancel` on a running job is `invalid-transition`.
- **Retry: explicitly deferred.** `failed` is terminal; no automatic retry or backoff. `attempts` is recorded on every claim so a future retry policy has truthful data; re-running a failed conversion is a new `enqueue` with a new id.
- **Crash/restart recovery:** a recovery sweep runs inside `open()` (every jobs command): each `running` row whose `owner_pid` is not alive (`process.kill(pid, 0)` → `ESRCH`) becomes `failed` with `error_code = "interrupted"` and `finished_at` set. A live owner's row is never touched, so a concurrent `run-next` and `jobs list` coexist safely. `ponytail:` pid liveness can be fooled by pid reuse — acceptable for a single-user local queue; upgrade path is lease timestamps, deferred.
- **Read revalidation:** `get`/`list` re-parse every row through the core per-status zod schema (queued rows carry no start/owner/error/artifact fields; running rows carry `started_at` + `owner_pid` and nothing terminal; completed rows carry the full artifact triple with absolute path, `bytes > 0`, 64-hex digest, and no `error_code`; failed rows carry `error_code` and no artifact; canceled rows carry neither `started_at` nor artifact). Any mismatch → `invalid-stored-data`, mirroring `readItem`. Reads do not re-hash artifact files (the record is history; the digest was verified at the only moment `completed` could be written).

### Wire shapes (hardened protocol, one physical line)

```json
{"ok":true,"value":{"job":{"id":"job_<uuid>","status":"queued","inputPath":"/abs/in.epub","inputFormat":"epub","outputFormat":"pdf","outputPath":"/abs/out.pdf","createdAt":"2026-07-19T00:00:00.000Z","attempts":0}}}
{"ok":true,"value":{"job":{"id":"job_<uuid>","status":"completed","...":"...","startedAt":"…","finishedAt":"…","attempts":1,"artifact":{"path":"/abs/out.pdf","bytes":12345,"sha256":"<hex>"}}}}
{"ok":true,"value":{"jobs":[ ]}}
{"ok":true,"value":{"job":null}}
{"ok":false,"error":{"code":"invalid-transition"}}
```

Frozen queue error codes: `invalid-arguments`, `storage-unavailable`, `incompatible-schema`, `invalid-stored-data`, `unknown-job`, `invalid-transition`, `artifact-invalid`, plus the reused convert preflight codes at enqueue and `backend-unavailable` from `run-next`. Job-level failure codes (`conversion-failed`, `conversion-timeout`, `artifact-invalid`, `source-unavailable`, `output-file-exists`, `copy-failed`, `interrupted`) appear as **data** in `errorCode` on failed jobs, not as command errors.

## Artifact and partial ownership

The queue does not invent artifact locations in this slice: `--output` remains a required, user-chosen absolute path recorded at enqueue (consistent with local-conversion assumption 5; a queue-owned artifacts directory arrives with library-artifact import, deferred). All workspace/partial mechanics belong to the reused executor (mkdtemp workspace, symlink-rejecting containment-checked validation, partial-then-rename-then-fsync); the queue adds only the completion-time revalidation above. The queue never deletes user inputs, preexisting outputs, or anything in `library.sqlite`/`items/`/`covers/`; the only files it ever creates are `jobs.sqlite` and, indirectly through the executor, the requested output. `--overwrite` is **not** offered for queued jobs (`ponytail:` a deferred-destruction flag widens the time-of-check window on a file the user may repopulate; enqueue and run both refuse an existing output with `output-file-exists`; add overwrite only with evidence of need).

## CLI integration (no pretend background work)

New `jobs` subtree, all registered via `storageCommand` with the hardened protocol and explicit exit semantics (0 + `ok:true`; nonzero + `ok:false`, empty stderr):

- `takio jobs enqueue --input <path> --to <format> --output <path>` — persist a queued job.
- `takio jobs list [--status <status>]`, `takio jobs get <id>` — deterministic inspection primitives for agents.
- `takio jobs cancel <id>` — queued-only.
- `takio jobs run-next [--timeout-seconds <n>]` — the **one-shot local worker**: recovery sweep, then backend discovery **before** claiming (a missing backend is an environment failure → `{"ok":false,"error":{"code":"backend-unavailable"}}`, exit 1, queue untouched); then claim the oldest queued job and run the synchronous executor in the foreground; then `complete`/`fail`. Job-specific run-time failures (source vanished, output appeared) happen **after** claim and terminally fail the job — truthful state, no silent requeue. Empty queue → `{"ok":true,"value":{"job":null}}`, exit 0. A job that ran and failed is still a **successful command** (exit 0, `ok:true`, `status:"failed"` with `errorCode` as data): the worker's contract is "advance the queue truthfully," and agents branch on job status, not exit code.

There is no daemon, no detach, no progress stream: `run-next`'s process lifetime is the job's lifetime, exactly like `convert`. Agents get durability plus stable primitives (`enqueue` → loop `run-next` until `job:null` → `get`); nothing claims background execution that does not exist. **`takio convert` is unchanged after this phase:** it remains the synchronous, queue-bypassing path and never writes `jobs.sqlite`. Routing convert through the queue (and desktop wiring) is deferred to the desktop-conversion milestone — two entry points coexist deliberately and are documented, not merged. Data-dir resolution reuses `libraryPaths` (`TAKIO_DATA_DIR` / platform default), with `jobs.sqlite` beside `library.sqlite`; a `--db` override for jobs is deferred until a caller needs it.

## Phases (strict order)

**Phase 0 — dependency gate.** Verify the capability-aware planning milestone and local-conversion terminal slice are merged (files named in "Waterfall position", full core and CLI suites green). No queue file is created before this passes. If either landed surface differs from its plan, re-ground Phases 2–4 against reality before writing code — do not average a plan and its landing.

**Phase 1 — pure job domain in `@takio/core`.** Depends on Phase 0.
Create `packages/core/src/jobs.ts`, `packages/core/test/jobs.test.ts`; modify `packages/core/src/index.ts` (re-export only). Contents: `JOB_STATUSES`, terminal set, `canTransitionJob(from, to)`, frozen `JOB_STORE_ERROR_CODES`, per-status zod record schema, wire types. Pure — no fs, no process, no SQLite.
Tests encode WHY: the transition table is asserted **exhaustively over all 25 pairs** so adding a status without deciding its edges fails loudly; a completed record without a full artifact triple is invalid *because completion without a verified artifact is a lie*; canceled-with-`started_at` is invalid *because cancellation is queued-only by contract*.

**Phase 2 — durable job store in the CLI.** Depends on Phase 1.
Create `apps/cli/src/job-store.ts`, `apps/cli/src/job-store-test-seam.ts` (initialization interpose, mirroring `initialization-test-seam.ts`), `apps/cli/test/job-store.test.ts`. API: `open`, `enqueue`, `list`, `get`, `claim`, `complete`, `fail`, `cancel`, `close`, with the recovery sweep inside `open`. Reuses exported `hashFile`; every mutation in `.immediate()` transactions; `LibraryStoreResult`-shaped returns.
Tests encode WHY (all in `apps/cli/test/job-store.test.ts`):

- enqueue → close → reopen → `get` returns the identical record — *durability is the entire point of this slice*;
- a nonempty version-0 file and a `user_version = 2` file are both refused byte-for-byte unmodified (hash the file before/after) — *the store never claims or mutates a database it does not own*, mirroring the library-store tests;
- the initialization seam holds the lock between preflight and DDL under a second connection;
- **two real `Database` connections race `claim` over N jobs: every job is claimed exactly once, no job twice** — *the atomic-claim invariant under real concurrency, not mocked*;
- every invalid transition (complete a queued job, cancel a running job, fail a completed job, any exit from terminal states) returns `invalid-transition` and leaves the row byte-identical;
- artifact tampering at `complete`: missing file, empty file, symlink at the output path, digest mismatch, byte-count mismatch, and a path that is not the recorded `output_path` each yield `artifact-invalid` and the row stays `running` — *`completed` is unreachable without a verified artifact*;
- a hand-corrupted persisted row (e.g. completed with NULLed `artifact_sha256`) surfaces `invalid-stored-data` on read — *the store revalidates what it stored*;
- a `running` row with a dead `owner_pid` becomes `failed`/`interrupted` on reopen, while a live-pid row is untouched (liveness injectable) — *restart yields truthful state without killing a live worker's job*.

**Phase 3 — queue CLI surface (no execution).** Depends on Phase 2.
Modify `apps/cli/src/main.ts` (register `jobs enqueue|list|get|cancel` via `storageCommand`), `apps/cli/src/convert.ts` (export the existing preflight helpers only — no behavior change); create `apps/cli/test/jobs.test.ts`. After this phase the CLI can persist and inspect jobs but nothing advances them past `queued`/`canceled` — and says so truthfully.
Tests encode WHY: process-level `invokeProcess` assertions that every command emits exactly one physical JSON line, empty stderr, correct exit code, no Commander prose — *the desktop sidecar and agents parse this protocol; a second line is a breaking change*; enqueue of an unsupported pair or missing source fails with the convert-slice code and persists **no row**; `list` ordering is byte-stable across invocations; `cancel` of a running row (seeded via the store) is `invalid-transition`.

**Phase 4 — one-shot worker: `jobs run-next` (terminal slice).** Depends on Phase 3.
Modify `apps/cli/src/main.ts` (register `run-next`, orchestrating discovery → sweep → claim → executor → complete/fail), extend `apps/cli/test/jobs.test.ts`.
Tests encode WHY (fake backend fixture, `TAKIO_EBOOK_CONVERT`, `TAKIO_DATA_DIR` temp dirs):

- **fake-executor end-to-end:** enqueue → `run-next` → `get` shows `completed`; the reported `sha256`/`bytes` match an independently hashed output file — *the persisted record and the disk artifact cannot disagree*;
- fake failure modes (exit-nonzero, write-empty, write-symlink, write-nothing) each end `failed` with the executor's code persisted in `errorCode`, no file at the output path, exit 0 with `ok:true` — *job failure is data; the queue advanced truthfully*;
- missing backend → `backend-unavailable`, exit 1, and the job is **still queued** — *environment failures never burn a job*;
- empty queue → `{"ok":true,"value":{"job":null}}`, exit 0;
- two concurrent `run-next` processes over one queued job: exactly one converts, the other reports `job:null` or the next job — *the claim race holds at process level*;
- **crash recovery end-to-end:** spawn `run-next` with the fake in sleep mode, `SIGKILL` the CLI mid-run, then any jobs command shows the job `failed`/`interrupted`, never `completed`, never stuck `running` — *a crash cannot manufacture success or wedge the queue*.

**Phase 5 — documentation.** Depends on Phase 4.
Modify `docs/architecture.md` (Controller/queue row → "Implemented: local SQLite queue, one-shot worker" + one sentence on the separate `jobs.sqlite` boundary) and `README.md` (add the `jobs` commands to the CLI contract table). Touch nothing unrelated.

## Exact runnable verification

```sh
bun install
bun run --filter '@takio/core' check && bun run --filter '@takio/core' test   # after Phase 1
bun run --filter '@takio/cli' check && bun run --filter '@takio/cli' test     # after Phases 2–4
bun run check && bun run test && bun run build                                # full workspace gates
git diff --check

# Process-level fake-executor queue flow (no calibre; CI-equivalent)
export TAKIO_DATA_DIR="$(mktemp -d)"
printf 'hello takio' > /tmp/takio-q-in.txt
bun run takio jobs enqueue --input /tmp/takio-q-in.txt --to epub --output /tmp/takio-q-out.epub
bun run takio jobs list                       # one queued job, deterministic order
FAKE_EBOOK_CONVERT_MODE=copy-input \
TAKIO_EBOOK_CONVERT="$PWD/apps/cli/test/fixtures/fake-ebook-convert.ts" \
  bun run takio jobs run-next                 # status completed + artifact triple
shasum -a 256 /tmp/takio-q-out.epub           # must equal the persisted sha256
bun run takio jobs run-next                   # {"ok":true,"value":{"job":null}}
```

**Skipped / manual checks, surfaced:** (1) a real-`ebook-convert` queued conversion — manual, gated behind the local-conversion plan's own unexecuted Phase-4 smoke gate; run once via the calibre bundle path after that gate passes and record the artifact hash; (2) pid-reuse defeating the recovery sweep — not deterministically testable; covered only by the injectable-liveness unit test and the `ponytail:` ceiling note; (3) desktop behavior — untouched, regression-covered only by the existing `bun run test` suite; no desktop wiring is claimed.

## Assumptions

1. The planning and local-conversion slices land with their planned exports (`ConversionCapability`, `ExecutionTarget`, `validateConversionPair`, discovery, preflight, execution entry, fake fixture). Phase 0 verifies rather than assumes.
2. `bun:sqlite` in Bun 1.3.13 supports `UPDATE … RETURNING` (SQLite ≥ 3.35). Verify at implementation start; fallback is `SELECT`-then-`UPDATE` inside one `.immediate()` transaction — same invariant, no new dependency.
3. Single machine, single POSIX user; `process.kill(pid, 0)` liveness is adequate for recovery.
4. Timestamps are ISO-8601 UTC strings; `(created_at, id)` is an acceptable deterministic order (no monotonic-clock guarantee is claimed).
5. No new third-party dependency anywhere in this plan.

## Conflicts surfaced (not blended)

- **busy_timeout divergence:** the library store sets neither WAL nor busy_timeout; the queue store needs busy_timeout for its concurrency contract. Applied to `jobs.sqlite` only; the library store is byte-identical.
- **Package-boundary divergence:** library storage = contract package + store package; queue = single CLI module, because there is exactly one consumer. Deliberate; extraction flagged if a second direct consumer appears.
- **Two conversion entry points:** `convert` (synchronous, queue-bypassing) and `enqueue`/`run-next` coexist. Convergence deferred to desktop wiring; documented in Phase 5, not merged now.
- **Planner/store boundary:** `planConversion` produces an in-memory planned job; the queue persists its own execution lifecycle. Both consume the same upstream capability-pair truth, but their job types stay separate because their states and lifetimes differ.

## Non-goals

Desktop/Tauri wiring; any network, remote execution, device agent, or content server; live progress; active-process cancellation; automatic retry/backoff; batching, priorities, scheduling/cron; daemons or background detach; queue-owned artifact directories or library-artifact import; converting library items by id; job deletion/pruning/history GC; `--overwrite` for queued jobs; `--db` override for jobs commands; WAL; lease-based ownership; any `library.sqlite` schema change; changing `planConversion`, `ExecutionTarget`, capability matching, or the legacy `formats`/`devices`/`plan` protocol.

## Success and exit criteria

1. A job enqueued, executed via the fake backend, and reopened across processes shows `completed` with an artifact triple that matches an independent hash of the file on disk — with zero skipped tests.
2. `completed` is test-proven unreachable without executor success plus store-side artifact revalidation (tampering suite), and every invalid transition is proven side-effect-free.
3. The two-connection claim race (store level) and two-process `run-next` race both prove single-winner claiming; the SIGKILL crash test proves restart yields `failed`/`interrupted`, never a wedged or lying state.
4. A future-version and a foreign `jobs.sqlite` are refused byte-for-byte unmodified.
5. Every `jobs` command satisfies the hardened protocol under the same process-level assertions as the library suite; all existing commands, including `convert`, are byte-identical.
6. `bun run check`, `bun run test`, `bun run build` pass at every micro-commit.

## Rollback, data recovery, and the schema risk gate

Everything is additive: no change to `library.sqlite`, no dependency, no background process. Safe-disable is removing the `jobs` registration from `apps/cli/src/main.ts`; full rollback is reverting the commits. `jobs.sqlite` may be deleted outright as a last-resort recovery — it loses only job history; inputs, artifacts, and library data are never stored in it (documented in Phase 5). An interrupted run recovers via the sweep; a corrupted or foreign `jobs.sqlite` is refused (`incompatible-schema`/`storage-unavailable`) rather than repaired. **Schema risk gate:** queue schema v1 is frozen at first ship behind `user_version`; any future v2 must ship the library store's backup-then-migrate-then-verify discipline (serialized `.v1.backup`, verified, single transaction) before any `ALTER`, and until such a migration exists the incompatible-schema refusal path is the only forward behavior.

## Micro-commit boundaries (waterfall order)

1. `feat(core): add persistent job domain` — Phase 1. Verified by core check/test. Claims a state machine, not persistence.
2. `feat(cli): add durable conversion job store` — Phase 2. Verified by cli check/test including the two-connection race and tampering suites. Claims durable records, not execution.
3. `feat(cli): enqueue and inspect conversion jobs` — Phase 3. Verified by cli check/test plus process-level protocol assertions. Claims queueing, not execution.
4. `feat(cli): run queued conversions with a one-shot worker` — Phase 4, the terminal integration slice and the **first commit allowed to claim durable execution**. Verified by the full cli suite plus the fake-executor process flow above.
5. `docs: record the persistent job queue contract` — Phase 5. Verified by `git diff --check`; lands only after 4 is green.

Each commit passes `bun run check && bun run test` independently; no commit before 4 may describe Takio as executing queued jobs, and none may ever describe the queue as background or remote.
