import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { JobStore } from "../src/job-store.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "takio-jobs-"));
  temporaryDirectories.push(directory);
  return join(directory, "jobs.sqlite");
}

function queuedInput(number: number, root: string = "/tmp") {
  return {
    inputPath: join(root, `input-${number}.epub`),
    inputFormat: "epub" as const,
    outputFormat: "pdf" as const,
    outputPath: join(root, `output-${number}.pdf`),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JobStore", () => {
  it("migrates v1 jobs without changing their durable records or adding a foreign key", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const database = new Database(path, { create: true, strict: true });
    database.run(`
      CREATE TABLE jobs (
        enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
        input_path TEXT NOT NULL,
        input_format TEXT NOT NULL,
        output_format TEXT NOT NULL,
        output_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        owner_pid INTEGER,
        error_code TEXT,
        artifact_bytes INTEGER,
        artifact_sha256 TEXT
      ) STRICT
    `);
    database.run("CREATE INDEX jobs_status_order ON jobs(status, enqueue_sequence)");
    database.run(`
      INSERT INTO jobs
        (id, status, input_path, input_format, output_format, output_path, created_at)
      VALUES ('job_legacy', 'queued', ?, 'epub', 'pdf', ?, '2026-07-19T12:00:00.000Z')
    `, [join(root, "legacy.epub"), join(root, "legacy.pdf")]);
    database.run(`
      INSERT INTO jobs
        (id, status, input_path, input_format, output_format, output_path, created_at,
          started_at, finished_at, artifact_bytes, artifact_sha256)
      VALUES ('job_legacy_completed', 'completed', ?, 'epub', 'pdf', ?,
        '2026-07-19T12:01:00.000Z', '2026-07-19T12:02:00.000Z',
        '2026-07-19T12:03:00.000Z', 512, ?)
    `, [join(root, "completed.epub"), join(root, "completed.pdf"), "a".repeat(64)]);
    database.run("PRAGMA user_version = 1");
    database.close();

    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });
    expect(store.list()).toEqual({
      ok: true,
      value: [{
        id: "job_legacy",
        status: "queued",
        inputPath: join(root, "legacy.epub"),
        inputFormat: "epub",
        outputFormat: "pdf",
        outputPath: join(root, "legacy.pdf"),
        createdAt: "2026-07-19T12:00:00.000Z",
      }, {
        id: "job_legacy_completed",
        status: "completed",
        inputPath: join(root, "completed.epub"),
        inputFormat: "epub",
        outputFormat: "pdf",
        outputPath: join(root, "completed.pdf"),
        createdAt: "2026-07-19T12:01:00.000Z",
        startedAt: "2026-07-19T12:02:00.000Z",
        finishedAt: "2026-07-19T12:03:00.000Z",
        artifact: {
          path: join(root, "completed.pdf"),
          bytes: 512,
          sha256: "a".repeat(64),
        },
      }],
    });
    store.close();

    using migrated = new Database(path, { strict: true });
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(jobs)").all().map(({ name }) => name)).toContain("library_item_id");
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(jobs)").all().map(({ name }) => name)).toContain("attachment_status");
    expect(migrated.query("PRAGMA foreign_key_list(jobs)").all()).toEqual([]);
  });

  it("migrates v2 completed linked jobs to pending while completed unlinked jobs remain unchanged", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const database = new Database(path, { create: true, strict: true });
    database.run(`
      CREATE TABLE jobs (
        enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
        library_item_id TEXT,
        input_path TEXT NOT NULL,
        input_format TEXT NOT NULL,
        output_format TEXT NOT NULL,
        output_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        owner_pid INTEGER,
        error_code TEXT,
        artifact_bytes INTEGER,
        artifact_sha256 TEXT
      ) STRICT
    `);
    database.run("CREATE INDEX jobs_status_order ON jobs(status, enqueue_sequence)");
    const insert = database.query(`
      INSERT INTO jobs
        (id, status, library_item_id, input_path, input_format, output_format, output_path,
          created_at, started_at, finished_at, artifact_bytes, artifact_sha256)
      VALUES (?, 'completed', ?, ?, 'epub', 'pdf', ?,
        '2026-07-19T12:00:00.000Z', '2026-07-19T12:01:00.000Z',
        '2026-07-19T12:02:00.000Z', 10, ?)
    `);
    insert.run("job_v2_linked", "book-1", join(root, "linked.epub"), join(root, "linked.pdf"), "a".repeat(64));
    insert.run("job_v2_unlinked", null, join(root, "unlinked.epub"), join(root, "unlinked.pdf"), "b".repeat(64));
    insert.run(
      "job_v2_linked_later",
      "book-2",
      join(root, "linked-later.epub"),
      join(root, "linked-later.pdf"),
      "c".repeat(64),
    );
    database.run("PRAGMA user_version = 2");
    database.close();

    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });
    expect(store.get("job_v2_linked")).toMatchObject({
      ok: true,
      value: { status: "completed", libraryItemId: "book-1", attachment: { status: "pending" } },
    });
    const unlinked = store.get("job_v2_unlinked");
    expect(unlinked).toMatchObject({ ok: true, value: { status: "completed" } });
    if (!unlinked.ok || !unlinked.value) throw new Error("missing migrated job");
    expect("attachment" in unlinked.value).toBe(false);
    expect(store.nextPendingAttachment()).toMatchObject({ ok: true, value: { id: "job_v2_linked" } });
    store.close();

    using migrated = new Database(path, { strict: true });
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
  });

  it("round-trips optional library item linkage while legacy enqueues remain unlinked", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });

    const linked = store.enqueue({
      ...queuedInput(1, root),
      libraryItemId: "book-1",
    });
    const unlinked = store.enqueue(queuedInput(2, root));
    expect(linked).toMatchObject({ ok: true, value: { libraryItemId: "book-1" } });
    if (!linked.ok || !unlinked.ok) throw new Error("enqueue failed");
    expect(unlinked.value.id.startsWith("job_")).toBe(true);
    expect("libraryItemId" in unlinked.value).toBe(false);
    store.close();

    const reopened = new JobStore(path);
    expect(reopened.open()).toEqual({ ok: true, value: null });
    expect(reopened.get(linked.value.id)).toMatchObject({
      ok: true,
      value: { libraryItemId: "book-1" },
    });
    const reopenedUnlinked = reopened.get(unlinked.value.id);
    expect(reopenedUnlinked).toMatchObject({
      ok: true,
      value: { id: unlinked.value.id },
    });
    if (!reopenedUnlinked.ok || !reopenedUnlinked.value) throw new Error("missing job");
    expect("libraryItemId" in reopenedUnlinked.value).toBe(false);
    reopened.close();
  });

  it("keeps conversion completion independent from linked attachment success", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });

    const unlinked = store.enqueue(queuedInput(1, root));
    const linked = store.enqueue({ ...queuedInput(2, root), libraryItemId: "book-2" });
    if (!unlinked.ok || !linked.ok) throw new Error("enqueue failed");

    expect(store.claimNext(101)).toMatchObject({ ok: true, value: { id: unlinked.value.id } });
    await writeFile(unlinked.value.outputPath, "unlinked artifact");
    const completedUnlinked = await store.complete(unlinked.value.id, {
      path: unlinked.value.outputPath,
      bytes: Buffer.byteLength("unlinked artifact"),
      sha256: sha256("unlinked artifact"),
    });
    expect(completedUnlinked).toMatchObject({ ok: true, value: { status: "completed" } });
    if (!completedUnlinked.ok) throw new Error("completion failed");
    expect("attachment" in completedUnlinked.value).toBe(false);
    expect(store.nextPendingAttachment()).toEqual({ ok: true, value: null });

    expect(store.claimNext(102)).toMatchObject({ ok: true, value: { id: linked.value.id } });
    await writeFile(linked.value.outputPath, "linked artifact");
    expect(await store.complete(linked.value.id, {
      path: linked.value.outputPath,
      bytes: Buffer.byteLength("linked artifact"),
      sha256: sha256("linked artifact"),
    })).toMatchObject({
      ok: true,
      value: { status: "completed", attachment: { status: "pending" } },
    });
    expect(store.nextPendingAttachment()).toMatchObject({ ok: true, value: { id: linked.value.id } });

    const attached = store.markAttached(linked.value.id);
    expect(attached).toMatchObject({
      ok: true,
      value: { status: "completed", attachment: { status: "attached" } },
    });
    if (!attached.ok || attached.value.attachment?.status !== "attached") throw new Error("attachment failed");
    expect(Date.parse(attached.value.attachment.finishedAt)).not.toBeNaN();
    expect(store.nextPendingAttachment()).toEqual({ ok: true, value: null });
    store.close();

    const reopened = new JobStore(path);
    expect(reopened.open()).toEqual({ ok: true, value: null });
    expect(reopened.get(linked.value.id)).toEqual(attached);
    const reopenedUnlinked = reopened.get(unlinked.value.id);
    if (!reopenedUnlinked.ok || !reopenedUnlinked.value) throw new Error("missing unlinked job");
    expect("attachment" in reopenedUnlinked.value).toBe(false);
    reopened.close();
  });

  it("persists failed attachments, retries them, and rejects invalid transitions", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });

    const linked = store.enqueue({ ...queuedInput(1, root), libraryItemId: "book-1" });
    const queued = store.enqueue({ ...queuedInput(2, root), libraryItemId: "book-2" });
    if (!linked.ok || !queued.ok) throw new Error("enqueue failed");
    expect(store.claimNext(201)).toMatchObject({ ok: true, value: { id: linked.value.id } });
    await writeFile(linked.value.outputPath, "artifact");
    expect((await store.complete(linked.value.id, {
      path: linked.value.outputPath,
      bytes: Buffer.byteLength("artifact"),
      sha256: sha256("artifact"),
    })).ok).toBe(true);

    const failed = store.markAttachmentFailed(linked.value.id, "library-unavailable");
    expect(failed).toMatchObject({
      ok: true,
      value: {
        status: "completed",
        attachment: { status: "failed", errorCode: "library-unavailable" },
      },
    });
    if (!failed.ok || failed.value.attachment?.status !== "failed") throw new Error("failure not stored");
    expect(Date.parse(failed.value.attachment.finishedAt)).not.toBeNaN();
    expect(store.markAttached(linked.value.id)).toEqual({ ok: false, error: { code: "invalid-transition" } });
    expect(store.markAttached(queued.value.id)).toEqual({ ok: false, error: { code: "invalid-transition" } });
    expect(store.markAttachmentFailed(queued.value.id, "nope")).toEqual({
      ok: false,
      error: { code: "invalid-transition" },
    });
    expect(store.retryAttachment(queued.value.id)).toEqual({ ok: false, error: { code: "invalid-transition" } });
    expect(store.markAttached("job_missing")).toEqual({ ok: false, error: { code: "unknown-job" } });
    store.close();

    const reopened = new JobStore(path);
    expect(reopened.open()).toEqual({ ok: true, value: null });
    expect(reopened.get(linked.value.id)).toEqual(failed);
    expect(reopened.retryAttachment(linked.value.id)).toMatchObject({
      ok: true,
      value: { status: "completed", attachment: { status: "pending" } },
    });
    expect(reopened.retryAttachment(linked.value.id)).toEqual({ ok: false, error: { code: "invalid-transition" } });
    expect(reopened.markAttached(linked.value.id)).toMatchObject({
      ok: true,
      value: { status: "completed", attachment: { status: "attached" } },
    });
    expect(reopened.markAttachmentFailed(linked.value.id, "late-error")).toEqual({
      ok: false,
      error: { code: "invalid-transition" },
    });
    reopened.close();
  });

  it("claims rapidly enqueued jobs in insertion order and persists terminal truth", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: true, value: null });

    const first = store.enqueue(queuedInput(1, root));
    const second = store.enqueue(queuedInput(2, root));
    const third = store.enqueue(queuedInput(3, root));
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) throw new Error("enqueue failed");

    const claimedFirst = store.claimNext(101);
    expect(claimedFirst.ok && claimedFirst.value?.id).toBe(first.value.id);
    const completedBytes = "completed file";
    await writeFile(first.value.outputPath, completedBytes);
    expect(await store.complete(first.value.id, {
      path: first.value.outputPath,
      bytes: Buffer.byteLength(completedBytes),
      sha256: sha256(completedBytes),
    })).toMatchObject({
      ok: true,
      value: {
        status: "completed",
        artifact: { path: first.value.outputPath, bytes: Buffer.byteLength(completedBytes) },
      },
    });
    expect(store.claimNext(102)).toMatchObject({ ok: true, value: { id: second.value.id } });
    expect(store.fail(second.value.id, "conversion-failed")).toMatchObject({
      ok: true,
      value: { status: "failed", errorCode: "conversion-failed" },
    });
    expect(store.cancel(third.value.id)).toMatchObject({ ok: true, value: { status: "canceled" } });
    store.close();

    const reopened = new JobStore(path);
    expect(reopened.open()).toEqual({ ok: true, value: null });
    expect(reopened.list()).toMatchObject({
      ok: true,
      value: [
        { id: first.value.id, status: "completed" },
        { id: second.value.id, status: "failed" },
        { id: third.value.id, status: "canceled" },
      ],
    });
    reopened.close();
  });

  it("leaves a running job unchanged when its recorded artifact cannot be independently verified", async () => {
    const path = await databasePath();
    const root = dirname(path);
    const store = new JobStore(path);
    expect(store.open().ok).toBe(true);
    const validHash = sha256("x");
    const cases = [
      { name: "missing", prepare: async (_output: string) => {}, bytes: 1, hash: validHash },
      { name: "empty", prepare: (output: string) => writeFile(output, ""), bytes: 1, hash: validHash },
      {
        name: "symlink",
        prepare: async (output: string) => {
          const target = join(root, "symlink-target");
          await writeFile(target, "x");
          await symlink(target, output);
        },
        bytes: 1,
        hash: validHash,
      },
      { name: "size", prepare: (output: string) => writeFile(output, "xx"), bytes: 1, hash: validHash },
      { name: "hash", prepare: (output: string) => writeFile(output, "x"), bytes: 1, hash: sha256("y") },
      { name: "path", prepare: (output: string) => writeFile(output, "x"), bytes: 1, hash: validHash },
    ];

    for (const [index, testCase] of cases.entries()) {
      const enqueued = store.enqueue(queuedInput(index + 10, root));
      if (!enqueued.ok) throw new Error("enqueue failed");
      expect(store.claimNext(300 + index)).toMatchObject({ ok: true, value: { id: enqueued.value.id } });
      await testCase.prepare(enqueued.value.outputPath);
      const artifactPath = testCase.name === "path"
        ? join(root, "different-output.pdf")
        : enqueued.value.outputPath;
      expect(await store.complete(enqueued.value.id, {
        path: artifactPath,
        bytes: testCase.bytes,
        sha256: testCase.hash,
      }), testCase.name).toEqual({ ok: false, error: { code: "artifact-invalid" } });
      expect(store.get(enqueued.value.id), testCase.name).toMatchObject({
        ok: true,
        value: { status: "running" },
      });
      expect(store.fail(enqueued.value.id, "artifact-invalid").ok).toBe(true);
    }
    store.close();
  });

  it("atomically gives a queued job to only one claimant", async () => {
    const path = await databasePath();
    const firstStore = new JobStore(path);
    const secondStore = new JobStore(path);
    expect(firstStore.open().ok).toBe(true);
    expect(secondStore.open().ok).toBe(true);
    expect(firstStore.enqueue(queuedInput(1)).ok).toBe(true);

    const claims = await Promise.all([
      Promise.resolve().then(() => firstStore.claimNext(101)),
      Promise.resolve().then(() => secondStore.claimNext(102)),
    ]);
    expect(claims.filter((claim) => claim.ok && claim.value !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim.ok && claim.value === null)).toHaveLength(1);
    firstStore.close();
    secondStore.close();
  });

  it("marks only dead running owners as interrupted when reopening", async () => {
    const path = await databasePath();
    const store = new JobStore(path, () => true);
    expect(store.open().ok).toBe(true);
    const dead = store.enqueue(queuedInput(1));
    const live = store.enqueue(queuedInput(2));
    if (!dead.ok || !live.ok) throw new Error("enqueue failed");
    expect(store.claimNext(111).ok).toBe(true);
    expect(store.claimNext(222).ok).toBe(true);
    store.close();

    const reopened = new JobStore(path, (pid) => pid === 222);
    expect(reopened.open()).toEqual({ ok: true, value: null });
    expect(reopened.get(dead.value.id)).toMatchObject({
      ok: true,
      value: { status: "failed", errorCode: "interrupted" },
    });
    expect(reopened.get(live.value.id)).toMatchObject({
      ok: true,
      value: { status: "running", ownerPid: 222 },
    });
    reopened.close();
  });

  it("rejects an unknown schema instead of overwriting it", async () => {
    const path = await databasePath();
    using database = new Database(path, { create: true });
    database.run("CREATE TABLE unrelated (value TEXT) STRICT");
    database.close();

    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: false, error: { code: "incompatible-schema" } });
  });

  it("does not change journal mode or contents before rejecting an incompatible WAL database", async () => {
    const path = await databasePath();
    const database = new Database(path, { create: true, strict: true });
    expect(database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode).toBe("wal");
    database.run("CREATE TABLE foreign_data (value TEXT NOT NULL) STRICT");
    database.run("INSERT INTO foreign_data VALUES ('preserve me')");
    database.run("PRAGMA user_version = 99");
    database.close();

    const store = new JobStore(path);
    expect(store.open()).toEqual({ ok: false, error: { code: "incompatible-schema" } });

    using preserved = new Database(path, { strict: true });
    expect(preserved.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(preserved.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(99);
    expect(preserved.query<{ value: string }, []>("SELECT value FROM foreign_data").get()?.value).toBe("preserve me");
  });
});
