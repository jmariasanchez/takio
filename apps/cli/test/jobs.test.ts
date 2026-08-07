import { afterEach, describe, expect, it } from "bun:test";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobStore, type ConversionJob } from "../src/job-store.js";

const CLI = join(import.meta.dir, "../src/main.ts");
const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-convert.ts");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-jobs-cli-"));
  roots.push(root);
  return realpath(root);
}

async function runJobs(
  args: readonly string[],
  backend: string = FAKE_BACKEND,
  dataDirectory?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", CLI, "jobs", ...args], {
    env: {
      ...process.env,
      TAKIO_EBOOK_CONVERT: backend,
      ...(dataDirectory ? { TAKIO_DATA_DIR: dataDirectory } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function record(result: { stdout: string; stderr: string }): any {
  expect(result.stderr).toBe("");
  const output = result.stdout.trim();
  expect(output).not.toContain("\n");
  expect(output).not.toContain("\r");
  return JSON.parse(output);
}

async function createMultiFormatItem(
  root: string,
  options: { includePdf?: boolean } = {},
): Promise<{ mobi: string; epub: string }> {
  const mobi = join(root, "primary.mobi");
  const epub = join(root, "secondary.epub");
  await Promise.all([
    writeFile(mobi, "primary mobi"),
    writeFile(epub, "secondary epub"),
  ]);

  const store = new BunSqliteLibraryStore(join(root, "library.sqlite"));
  expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
  const addedAt = "2026-07-20T12:00:00.000Z";
  expect(await store.add({
    item: {
      id: "book-1",
      title: "Multi-format book",
      sourcePath: mobi,
      format: "mobi",
      addedAt,
      formats: [{ sourcePath: mobi, format: "mobi", addedAt, provenance: "referenced" }],
      tags: [],
    },
  })).toMatchObject({ ok: true });
  expect(await store.attachFormat({
    id: "book-1",
    source: { kind: "reference", path: epub },
  })).toMatchObject({ ok: true });
  if (options.includePdf) {
    const pdf = join(root, "existing-library-format.pdf");
    await writeFile(pdf, "existing pdf");
    expect(await store.attachFormat({
      id: "book-1",
      source: { kind: "reference", path: pdf },
    })).toMatchObject({ ok: true });
  }
  store.close();
  return { mobi: await realpath(mobi), epub: await realpath(epub) };
}

async function seedCompletedLinkedJob(options: {
  database: string;
  input: string;
  output: string;
  libraryItemId: string;
  contents: string;
}): Promise<ConversionJob> {
  await writeFile(options.input, "source epub");
  const store = new JobStore(options.database);
  expect(store.open()).toEqual({ ok: true, value: null });
  try {
    const queued = store.enqueue({
      libraryItemId: options.libraryItemId,
      inputPath: options.input,
      inputFormat: "epub",
      outputFormat: "pdf",
      outputPath: options.output,
    });
    if (!queued.ok) throw new Error(`enqueue failed: ${queued.error.code}`);
    expect(store.claimNext()).toMatchObject({ ok: true, value: { id: queued.value.id } });
    await writeFile(options.output, options.contents);
    const completed = await store.complete(queued.value.id, {
      path: options.output,
      bytes: Buffer.byteLength(options.contents),
      sha256: createHash("sha256").update(options.contents).digest("hex"),
    });
    if (!completed.ok) throw new Error(`completion failed: ${completed.error.code}`);
    return completed.value;
  } finally {
    store.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("takio jobs", () => {
  it("persists enqueue, list, get, and cancel through the one-record protocol", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, "book");

    const enqueued = await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ]);
    expect(enqueued.exitCode).toBe(0);
    const job = record(enqueued).value.job;
    expect(job).toMatchObject({ status: "queued", inputPath: input, outputPath: output });
    expect("libraryItemId" in job).toBe(false);

    const listed = await runJobs(["list", "--db", database, "--status", "queued"]);
    expect(listed.exitCode).toBe(0);
    expect(record(listed).value.jobs).toEqual([job]);

    const fetched = await runJobs(["get", "--db", database, "--id", job.id]);
    expect(fetched.exitCode).toBe(0);
    expect(record(fetched).value.job).toEqual(job);

    const canceled = await runJobs(["cancel", "--db", database, "--id", job.id]);
    expect(canceled.exitCode).toBe(0);
    expect(record(canceled).value.job).toMatchObject({ id: job.id, status: "canceled" });
  });

  it("runs one queued conversion and records its verified caller-owned artifact", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const blockedDataDirectory = join(root, "not-a-directory");
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    const bytes = JSON.stringify({ fakeEbookConvert: {} });
    await Promise.all([writeFile(input, bytes), writeFile(blockedDataDirectory, "blocked")]);
    expect((await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ], FAKE_BACKEND, blockedDataDirectory)).exitCode).toBe(0);

    const ran = await runJobs(["run-next", "--db", database], FAKE_BACKEND, blockedDataDirectory);
    expect(ran.exitCode).toBe(0);
    expect(record(ran)).toMatchObject({
      ok: true,
      value: { job: { status: "completed", artifact: { path: output, bytes: Buffer.byteLength(bytes) } } },
    });
    expect(await readFile(output, "utf8")).toBe(bytes);

    const empty = await runJobs(["run-next", "--db", database], FAKE_BACKEND, blockedDataDirectory);
    expect(empty.exitCode).toBe(0);
    expect(record(empty)).toEqual({ ok: true, value: { job: null } });
  });

  it("drains queued work up to the explicit bound and reports remaining progress", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    for (const number of [1, 2, 3]) {
      const input = join(root, `book-${number}.epub`);
      await writeFile(input, `book ${number}`);
      expect((await runJobs([
        "enqueue", "--db", database, "--input", input, "--to", "pdf",
        "--output", join(root, `book-${number}.pdf`),
      ])).exitCode).toBe(0);
    }

    const bounded = await runJobs(["drain", "--db", database, "--max-jobs", "2"]);
    expect(bounded.exitCode).toBe(0);
    expect(record(bounded)).toMatchObject({
      ok: true,
      value: {
        jobs: [{ status: "completed" }, { status: "completed" }],
        counts: { processed: 2, completed: 2, failed: 0, canceled: 0, remaining: 1 },
      },
    });

    const finished = await runJobs(["drain", "--db", database]);
    expect(finished.exitCode).toBe(0);
    expect(record(finished)).toMatchObject({
      value: {
        jobs: [{ status: "completed" }],
        counts: { processed: 1, completed: 1, failed: 0, canceled: 0, remaining: 0 },
      },
    });
  });

  it("stops a foreground drain after SIGINT cancels the active conversion", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const started = join(root, "started");
    const firstInput = join(root, "first.epub");
    const secondInput = join(root, "second.epub");
    await Promise.all([
      writeFile(firstInput, JSON.stringify({ fakeEbookConvert: { mode: "sleep", started } })),
      writeFile(secondInput, "second"),
    ]);
    for (const [input, output] of [
      [firstInput, join(root, "first.pdf")],
      [secondInput, join(root, "second.pdf")],
    ]) {
      expect((await runJobs([
        "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
      ])).exitCode).toBe(0);
    }

    const child = Bun.spawn(["bun", "run", CLI, "jobs", "drain", "--db", database], {
      env: { ...process.env, TAKIO_EBOOK_CONVERT: FAKE_BACKEND },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempts = 0; attempts < 100; attempts += 1) {
      try {
        await stat(started);
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    await stat(started);
    child.kill("SIGINT");
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(record({ stdout, stderr })).toMatchObject({
      value: {
        jobs: [{ status: "failed", errorCode: "conversion-cancelled" }],
        counts: { processed: 1, completed: 0, failed: 1, canceled: 0, remaining: 1 },
      },
    });
  });

  it("retries a failed job as new queued work while preserving the failed record", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, "source");
    const original = record(await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ])).value.job;
    await writeFile(output, "caller data");
    const failed = record(await runJobs(["run-next", "--db", database])).value.job;
    expect(failed).toMatchObject({ id: original.id, status: "failed", errorCode: "output-file-exists" });

    const retried = await runJobs(["retry", "--db", database, "--id", original.id]);
    expect(retried.exitCode).toBe(0);
    expect(record(retried)).toMatchObject({
      ok: true,
      value: {
        retriedFrom: original.id,
        job: { status: "queued", inputPath: input, outputPath: output },
      },
    });
    const retryJob = record(retried).value.job;
    expect(retryJob.id).not.toBe(original.id);
    expect(record(await runJobs(["get", "--db", database, "--id", original.id])).value.job)
      .toMatchObject({ status: "failed", errorCode: "output-file-exists" });

    await rm(output);
    expect(record(await runJobs(["run-next", "--db", database])).value.job).toMatchObject({
      id: retryJob.id,
      status: "completed",
    });
  });

  it("enqueues the exact requested library format instead of the primary alias", async () => {
    const root = await temporaryRoot();
    const { mobi, epub } = await createMultiFormatItem(root);
    const output = join(root, "converted.pdf");

    const enqueued = await runJobs([
      "enqueue",
      "--library-item-id", "book-1",
      "--from", "epub",
      "--to", "pdf",
      "--output", output,
    ], FAKE_BACKEND, root);

    expect(enqueued.exitCode).toBe(0);
    expect(record(enqueued)).toMatchObject({
      ok: true,
      value: {
        job: {
          status: "queued",
          libraryItemId: "book-1",
          inputPath: epub,
          inputFormat: "epub",
          outputFormat: "pdf",
          outputPath: output,
        },
      },
    });
    expect(record(enqueued).value.job.inputPath).not.toBe(mobi);
  });

  it("completes and attaches a linked conversion in the same run", async () => {
    const root = await temporaryRoot();
    const { mobi } = await createMultiFormatItem(root);
    const output = join(root, "converted.pdf");
    const enqueued = record(await runJobs([
      "enqueue",
      "--library-item-id", "book-1",
      "--from", "epub",
      "--to", "pdf",
      "--output", output,
    ], FAKE_BACKEND, root)).value.job;

    const ran = await runJobs(["run-next"], FAKE_BACKEND, root);

    expect(ran.exitCode).toBe(0);
    const job = record(ran).value.job;
    expect(job).toMatchObject({
      id: enqueued.id,
      status: "completed",
      libraryItemId: "book-1",
      attachment: { status: "attached" },
      artifact: { path: output },
    });
    expect(await readFile(output, "utf8")).toBe("secondary epub");

    const library = new BunSqliteLibraryStore(join(root, "library.sqlite"));
    expect(await library.open({ config: {} })).toEqual({ ok: true, value: null });
    try {
      const stored = await library.get({ id: "book-1" });
      if (!stored.ok || !stored.value) throw new Error("linked item missing");
      expect(stored.value.sourcePath).toBe(mobi);
      expect(stored.value.format).toBe("mobi");
      expect(stored.value.formats.map(({ format }) => format)).toEqual(["mobi", "epub", "pdf"]);
      expect(stored.value.formats[2]).toMatchObject({ format: "pdf", provenance: "managed" });
      expect(stored.value.formats[2]!.sourcePath).not.toBe(output);
      expect(await readFile(stored.value.formats[2]!.sourcePath, "utf8")).toBe("secondary epub");
    } finally {
      library.close();
    }

    expect(record(await runJobs(["get", "--id", job.id], FAKE_BACKEND, root)).value.job).toEqual(job);
  });

  it("leaves a completed linked job pending when older attachment work appears during conversion", async () => {
    const root = await temporaryRoot();
    await createMultiFormatItem(root);
    const started = join(root, "conversion-started");
    const gate = join(root, "finish-conversion");
    const backend = join(root, "gated-ebook-convert.ts");
    await writeFile(backend, `#!/usr/bin/env bun
import { copyFile, writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(started)}, "started");
while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10);
await copyFile(process.argv[2], process.argv[3]);
`);
    await chmod(backend, 0o755);

    const database = join(root, "jobs.sqlite");
    const olderInput = join(root, "older.epub");
    const olderOutput = join(root, "older.pdf");
    const olderContents = "older converted output";
    await writeFile(olderInput, "older source");
    const setupStore = new JobStore(database);
    expect(setupStore.open()).toEqual({ ok: true, value: null });
    let olderJobId: string;
    try {
      const olderQueued = setupStore.enqueue({
        libraryItemId: "missing-book",
        inputPath: olderInput,
        inputFormat: "epub",
        outputFormat: "pdf",
        outputPath: olderOutput,
      });
      if (!olderQueued.ok) throw new Error(`enqueue failed: ${olderQueued.error.code}`);
      olderJobId = olderQueued.value.id;
      expect(setupStore.claimNext()).toMatchObject({ ok: true, value: { id: olderJobId } });
    } finally {
      setupStore.close();
    }

    const output = join(root, "current.pdf");
    const current = record(await runJobs([
      "enqueue",
      "--library-item-id", "book-1",
      "--from", "epub",
      "--to", "pdf",
      "--output", output,
    ], FAKE_BACKEND, root)).value.job;
    const child = Bun.spawn(["bun", "run", CLI, "jobs", "run-next"], {
      env: { ...process.env, TAKIO_EBOOK_CONVERT: backend, TAKIO_DATA_DIR: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    let olderPending: ConversionJob | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!(await Bun.file(started).exists()) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      if (!(await Bun.file(started).exists())) throw new Error("conversion did not start");

      await writeFile(olderOutput, olderContents);
      const completionStore = new JobStore(database);
      expect(completionStore.open()).toEqual({ ok: true, value: null });
      try {
        const completed = await completionStore.complete(olderJobId, {
          path: olderOutput,
          bytes: Buffer.byteLength(olderContents),
          sha256: createHash("sha256").update(olderContents).digest("hex"),
        });
        if (!completed.ok) throw new Error(`completion failed: ${completed.error.code}`);
        olderPending = completed.value;
      } finally {
        completionStore.close();
      }
      await writeFile(gate, "finish");

      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(record({ stdout, stderr })).toMatchObject({
        ok: true,
        value: {
          job: { id: current.id, status: "completed", attachment: { status: "pending" } },
        },
      });
    } finally {
      await writeFile(gate, "finish");
      await child.exited;
    }

    const missingBackend = join(root, "missing-ebook-convert");
    expect(record(await runJobs(["run-next"], missingBackend, root))).toMatchObject({
      value: {
        job: {
          id: olderPending!.id,
          attachment: { status: "failed", errorCode: "library-item-not-found" },
        },
      },
    });
    expect(record(await runJobs(["run-next"], missingBackend, root))).toMatchObject({
      value: { job: { id: current.id, attachment: { status: "attached" } } },
    });
  });

  it("reconciles pending attachment before backend discovery or queued work", async () => {
    const root = await temporaryRoot();
    const { epub } = await createMultiFormatItem(root);
    const pending = await seedCompletedLinkedJob({
      database: join(root, "jobs.sqlite"),
      input: epub,
      output: join(root, "recovered.pdf"),
      libraryItemId: "book-1",
      contents: "recovered pdf",
    });
    const queuedInput = join(root, "queued.epub");
    const queuedOutput = join(root, "queued.pdf");
    await writeFile(queuedInput, "queued source");
    expect((await runJobs([
      "enqueue", "--input", queuedInput, "--to", "pdf", "--output", queuedOutput,
    ], FAKE_BACKEND, root)).exitCode).toBe(0);

    const missingBackend = join(root, "missing-ebook-convert");
    const recovered = await runJobs(["run-next"], missingBackend, root);

    expect(recovered.exitCode).toBe(0);
    expect(record(recovered)).toMatchObject({
      ok: true,
      value: { job: { id: pending.id, status: "completed", attachment: { status: "attached" } } },
    });
    expect(record(await runJobs(["list"], FAKE_BACKEND, root)).value.jobs).toMatchObject([
      { id: pending.id, status: "completed", attachment: { status: "attached" } },
      { status: "queued", outputPath: queuedOutput },
    ]);
    await expect(readFile(queuedOutput)).rejects.toThrow();

    const unavailable = await runJobs(["run-next"], missingBackend, root);
    expect(unavailable.exitCode).not.toBe(0);
    expect(record(unavailable)).toEqual({ ok: false, error: { code: "backend-unavailable" } });
    expect(record(await runJobs(["list", "--status", "queued"], FAKE_BACKEND, root)).value.jobs)
      .toMatchObject([{ outputPath: queuedOutput }]);
  });

  it("records a missing linked item as terminal attachment failure before queued work", async () => {
    const root = await temporaryRoot();
    const output = join(root, "missing-item.pdf");
    const pending = await seedCompletedLinkedJob({
      database: join(root, "jobs.sqlite"),
      input: join(root, "missing-item.epub"),
      output,
      libraryItemId: "missing-book",
      contents: "preserved converted output",
    });
    const queuedInput = join(root, "later.epub");
    const queuedOutput = join(root, "later.pdf");
    await writeFile(queuedInput, "later source");
    expect((await runJobs([
      "enqueue", "--input", queuedInput, "--to", "pdf", "--output", queuedOutput,
    ], FAKE_BACKEND, root)).exitCode).toBe(0);

    const ran = await runJobs(["run-next"], join(root, "missing-ebook-convert"), root);

    expect(ran.exitCode).toBe(0);
    expect(record(ran)).toMatchObject({
      ok: true,
      value: {
        job: {
          id: pending.id,
          status: "completed",
          attachment: { status: "failed", errorCode: "library-item-not-found" },
        },
      },
    });
    expect(await readFile(output, "utf8")).toBe("preserved converted output");
    expect(record(await runJobs(["list", "--status", "queued"], FAKE_BACKEND, root)).value.jobs)
      .toMatchObject([{ outputPath: queuedOutput }]);
    await expect(readFile(queuedOutput)).rejects.toThrow();

    const library = new BunSqliteLibraryStore(join(root, "library.sqlite"));
    expect(await library.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await library.add({
      item: {
        id: "missing-book",
        title: "Recovered book",
        sourcePath: pending.inputPath,
        format: "epub",
        addedAt: "2026-07-20T12:00:00.000Z",
        formats: [{
          sourcePath: pending.inputPath,
          format: "epub",
          addedAt: "2026-07-20T12:00:00.000Z",
          provenance: "referenced",
        }],
        tags: [],
      },
    })).toMatchObject({ ok: true });
    library.close();

    expect(record(await runJobs(["retry-attachment", "--id", pending.id], FAKE_BACKEND, root)))
      .toMatchObject({ value: { job: { attachment: { status: "pending" } } } });
    expect(record(await runJobs(["run-next"], join(root, "missing-ebook-convert"), root)))
      .toMatchObject({ value: { job: { attachment: { status: "attached" } } } });
  });

  it("rejects attachment retry against an unrelated explicit jobs database", async () => {
    const root = await temporaryRoot();
    const result = await runJobs([
      "retry-attachment", "--db", join(root, "custom-jobs.sqlite"), "--id", "job-1",
    ], FAKE_BACKEND, root);

    expect(result.exitCode).not.toBe(0);
    expect(record(result)).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  });

  it("rejects custom linked attachment recovery without touching the default library", async () => {
    const root = await temporaryRoot();
    const { epub } = await createMultiFormatItem(root);
    const database = join(root, "custom-jobs.sqlite");
    const output = join(root, "custom-linked.pdf");
    const pending = await seedCompletedLinkedJob({
      database,
      input: epub,
      output,
      libraryItemId: "book-1",
      contents: "custom converted output",
    });

    const ran = await runJobs(
      ["run-next", "--db", database],
      join(root, "missing-ebook-convert"),
      root,
    );

    expect(ran.exitCode).not.toBe(0);
    expect(record(ran)).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(record(await runJobs(["get", "--db", database, "--id", pending.id], FAKE_BACKEND, root)))
      .toMatchObject({ value: { job: { attachment: { status: "pending" } } } });
    expect(await readFile(output, "utf8")).toBe("custom converted output");

    const library = new BunSqliteLibraryStore(join(root, "library.sqlite"));
    expect(await library.open({ config: {} })).toEqual({ ok: true, value: null });
    try {
      expect(await library.get({ id: "book-1" })).toMatchObject({
        ok: true,
        value: { formats: [{ format: "mobi" }, { format: "epub" }] },
      });
    } finally {
      library.close();
    }
  });

  it("rejects invalid or unavailable linked enqueue requests before persisting a job", async () => {
    const cases = [
      {
        name: "unknown item",
        prepare: createMultiFormatItem,
        args: ["--library-item-id", "missing", "--from", "epub", "--to", "pdf"],
        code: "not-found",
      },
      {
        name: "missing exact source format",
        prepare: createMultiFormatItem,
        args: ["--library-item-id", "book-1", "--from", "azw3", "--to", "pdf"],
        code: "format-not-found",
      },
      {
        name: "existing target format",
        prepare: (root: string) => createMultiFormatItem(root, { includePdf: true }),
        args: ["--library-item-id", "book-1", "--from", "epub", "--to", "pdf"],
        code: "duplicate-format",
      },
      {
        name: "unsupported source pair",
        prepare: createMultiFormatItem,
        args: ["--library-item-id", "book-1", "--from", "mobi", "--to", "pdf"],
        code: "unsupported-conversion",
      },
      {
        name: "same source and target",
        prepare: createMultiFormatItem,
        args: ["--library-item-id", "book-1", "--from", "epub", "--to", "epub"],
        code: "unsupported-conversion",
      },
      {
        name: "caller output collision",
        prepare: async (root: string) => {
          await createMultiFormatItem(root);
          await writeFile(join(root, "converted.pdf"), "caller data");
        },
        args: ["--library-item-id", "book-1", "--from", "epub", "--to", "pdf"],
        code: "output-file-exists",
      },
    ] as const;

    for (const testCase of cases) {
      const root = await temporaryRoot();
      await testCase.prepare(root);
      const result = await runJobs([
        "enqueue",
        ...testCase.args,
        "--output", join(root, "converted.pdf"),
      ], FAKE_BACKEND, root);
      expect(result.exitCode, testCase.name).not.toBe(0);
      expect(record(result), testCase.name).toEqual({
        ok: false,
        error: { code: testCase.code },
      });

      const listed = await runJobs(["list"], FAKE_BACKEND, root);
      expect(record(listed).value.jobs, testCase.name).toEqual([]);
    }
  });

  it("rejects ambiguous linked source shapes and an explicit jobs database", async () => {
    const root = await temporaryRoot();
    await createMultiFormatItem(root);
    const output = join(root, "converted.pdf");
    const requests = [
      ["--input", join(root, "secondary.epub"), "--library-item-id", "book-1", "--from", "epub"],
      ["--library-item-id", "book-1"],
      ["--from", "epub"],
      ["--library-item-id", "book-1", "--from", "epub", "--db", join(root, "custom-jobs.sqlite")],
    ];

    for (const source of requests) {
      const result = await runJobs([
        "enqueue", ...source, "--to", "pdf", "--output", output,
      ], FAKE_BACKEND, root);
      expect(result.exitCode).not.toBe(0);
      expect(record(result)).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    }
  });

  it("records a run-time output collision as failure without modifying the output", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, "source");
    expect((await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ])).exitCode).toBe(0);
    await writeFile(output, "caller data");

    const ran = await runJobs(["run-next", "--db", database]);
    expect(ran.exitCode).toBe(0);
    expect(record(ran)).toMatchObject({
      ok: true,
      value: { job: { status: "failed", errorCode: "output-file-exists" } },
    });
    expect(await readFile(output, "utf8")).toBe("caller data");
  });

  it("rejects an existing output at enqueue and leaves queued work untouched when the backend is absent", async () => {
    const root = await temporaryRoot();
    const database = join(root, "jobs.sqlite");
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, "source");
    await writeFile(output, "existing");
    const rejected = await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ]);
    expect(rejected.exitCode).not.toBe(0);
    expect(record(rejected)).toEqual({ ok: false, error: { code: "output-file-exists" } });

    await rm(output);
    expect((await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ])).exitCode).toBe(0);
    const unavailable = await runJobs(
      ["run-next", "--db", database],
      join(root, "missing-ebook-convert"),
    );
    expect(unavailable.exitCode).not.toBe(0);
    expect(record(unavailable)).toEqual({ ok: false, error: { code: "backend-unavailable" } });
    const listed = await runJobs(["list", "--db", database]);
    expect(record(listed).value.jobs).toMatchObject([{ status: "queued" }]);
  });
});
