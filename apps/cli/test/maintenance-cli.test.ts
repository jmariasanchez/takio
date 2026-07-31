import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/main.ts");
const FAKE_EBOOK_CONVERT = join(import.meta.dir, "fixtures/fake-ebook-convert.ts");
const FAKE_EBOOK_META = join(import.meta.dir, "fixtures/fake-ebook-meta.ts");
const FAKE_EBOOK_POLISH = join(import.meta.dir, "fixtures/fake-ebook-polish.ts");

async function invoke(
  args: readonly string[],
  dataDirectory: string,
): Promise<Record<string, any>> {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    env: {
      ...process.env,
      TAKIO_DATA_DIR: dataDirectory,
      TAKIO_EBOOK_CONVERT: FAKE_EBOOK_CONVERT,
      TAKIO_EBOOK_META: FAKE_EBOOK_META,
      TAKIO_EBOOK_POLISH: FAKE_EBOOK_POLISH,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

describe("Calibre maintenance CLI", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-maintenance-cli-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("searches extracted content and validates every selected format", async () => {
    const sourcePath = join(directory, "book.epub");
    await Bun.write(sourcePath, "A bounded needle appears in this ebook.");
    expect((await invoke([
      "library", "add",
      "--id", "book-1",
      "--title", "Book one",
      "--source-path", sourcePath,
      "--format", "epub",
      "--added-at", "2026-07-31T12:00:00.000Z",
    ], directory)).ok).toBe(true);

    expect(await invoke([
      "library", "content-search",
      "--query", "NEEDLE",
      "--id", "book-1",
      "--id", "missing-book",
    ], directory)).toMatchObject({
      ok: true,
      value: {
        canceled: false,
        outcomes: [
          { status: "matched", itemId: "book-1", format: "epub", matches: 1 },
          { status: "missing", itemId: "missing-book" },
        ],
        counts: { total: 2, matched: 1, noMatch: 0, missing: 1, skipped: 0, failed: 0 },
      },
    });

    expect(await invoke([
      "library", "validate", "--id", "book-1", "--id", "missing-book",
    ], directory)).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          { status: "valid", itemId: "book-1", format: "epub", content: "checked" },
          { status: "missing", itemId: "missing-book" },
        ],
        counts: { total: 2, valid: 1, missing: 1, failed: 0 },
      },
    });
  });

  it("publishes a new polished artifact without replacing its input", async () => {
    const sourcePath = join(directory, "source.epub");
    const outputPath = join(directory, "polished.epub");
    await Bun.write(sourcePath, "source bytes");

    const result = await invoke([
      "polish",
      "--input", sourcePath,
      "--output", outputPath,
      "--operation", "remove-unused-css",
      "--operation", "compress-images",
    ], directory);

    expect(result).toMatchObject({
      ok: true,
      value: {
        job: {
          backend: "ebook-polish",
          inputFormat: "epub",
          operations: ["remove-unused-css", "compress-images"],
          artifact: { path: join(await realpath(directory), "polished.epub") },
        },
      },
    });
    expect(await Bun.file(sourcePath).text()).toBe("source bytes");
    expect(await Bun.file(outputPath).text()).toBe("source bytes");
  });

  it("rescans import roots in a bounded foreground watch", async () => {
    const importRoot = join(directory, "inbox");
    await mkdir(importRoot);
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        CLI,
        "library", "import-watch",
        "--source-path", importRoot,
        "--interval-seconds", "1",
        "--max-cycles", "2",
      ],
      env: {
        ...process.env,
        TAKIO_DATA_DIR: directory,
        TAKIO_EBOOK_CONVERT: FAKE_EBOOK_CONVERT,
        TAKIO_EBOOK_META: FAKE_EBOOK_META,
        TAKIO_EBOOK_POLISH: FAKE_EBOOK_POLISH,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(200);
    await Bun.write(join(importRoot, "arrived.epub"), "arrived ebook");
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      value: { cycles: 2, stopped: false, counts: { imported: 1 } },
    });
  });
});
