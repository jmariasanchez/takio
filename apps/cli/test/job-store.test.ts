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
