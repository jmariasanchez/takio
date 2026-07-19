import { afterEach, describe, expect, it } from "bun:test";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    const bytes = JSON.stringify({ fakeEbookConvert: {} });
    await writeFile(input, bytes);
    expect((await runJobs([
      "enqueue", "--db", database, "--input", input, "--to", "pdf", "--output", output,
    ])).exitCode).toBe(0);

    const ran = await runJobs(["run-next", "--db", database]);
    expect(ran.exitCode).toBe(0);
    expect(record(ran)).toMatchObject({
      ok: true,
      value: { job: { status: "completed", artifact: { path: output, bytes: Buffer.byteLength(bytes) } } },
    });
    expect(await readFile(output, "utf8")).toBe(bytes);

    const empty = await runJobs(["run-next", "--db", database]);
    expect(empty.exitCode).toBe(0);
    expect(record(empty)).toEqual({ ok: true, value: { job: null } });
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
