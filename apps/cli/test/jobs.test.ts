import { afterEach, describe, expect, it } from "bun:test";
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", CLI, "jobs", ...args], {
    env: { ...process.env, TAKIO_EBOOK_CONVERT: backend },
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
