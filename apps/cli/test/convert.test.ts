import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverEbookConvert } from "../src/convert.js";

const CLI = join(import.meta.dir, "../src/main.ts");
const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-convert.ts");
const roots: string[] = [];

function fakeInput(control: Record<string, string> = {}): string {
  return JSON.stringify({ fakeEbookConvert: control });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-convert-test-"));
  roots.push(root);
  return root;
}

async function runConvert(
  args: readonly string[],
  environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", CLI, "convert", ...args], {
    env: {
      ...process.env,
      TAKIO_EBOOK_CONVERT: FAKE_BACKEND,
      ...environment,
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

function record(result: { exitCode: number; stdout: string; stderr: string }) {
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toContain("\n");
  expect(result.stdout.trim()).not.toContain("\r");
  return JSON.parse(result.stdout.trim());
}

async function ownedFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter(
    (name) => name.startsWith("takio-convert-") || name.includes(".tmp-"),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ebook-convert discovery", () => {
  it("uses a pinned executable before PATH or the macOS bundle", async () => {
    const root = await temporaryRoot();
    const pinned = join(root, "pinned");
    const pathBinary = join(root, "ebook-convert");
    const bundleBinary = join(root, "bundle");
    for (const path of [pinned, pathBinary, bundleBinary]) {
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      await chmod(path, 0o755);
    }

    expect(
      await discoverEbookConvert(
        { TAKIO_EBOOK_CONVERT: pinned, PATH: root },
        "darwin",
        bundleBinary,
      ),
    ).toEqual({ ok: true, path: await realpath(pinned) });
  });

  it("uses PATH before the macOS bundle", async () => {
    const root = await temporaryRoot();
    const pathBinary = join(root, "ebook-convert");
    const bundleBinary = join(root, "bundle");
    for (const path of [pathBinary, bundleBinary]) {
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      await chmod(path, 0o755);
    }

    expect(await discoverEbookConvert({ PATH: root }, "darwin", bundleBinary)).toEqual({
      ok: true,
      path: await realpath(pathBinary),
    });
  });

  it("uses the macOS bundle after a PATH miss", async () => {
    const root = await temporaryRoot();
    const bundleBinary = join(root, "bundle");
    await writeFile(bundleBinary, "#!/bin/sh\nexit 0\n");
    await chmod(bundleBinary, 0o755);

    expect(await discoverEbookConvert({ PATH: root }, "darwin", bundleBinary)).toEqual({
      ok: true,
      path: await realpath(bundleBinary),
    });
  });

  it("fails closed for empty or unusable pinned overrides", async () => {
    const root = await temporaryRoot();
    const pathBinary = join(root, "ebook-convert");
    await writeFile(pathBinary, "#!/bin/sh\nexit 0\n");
    await chmod(pathBinary, 0o755);

    expect(
      await discoverEbookConvert({ TAKIO_EBOOK_CONVERT: "", PATH: root }, "darwin", pathBinary),
    ).toEqual({ ok: false, code: "invalid-arguments" });
    expect(
      await discoverEbookConvert(
        { TAKIO_EBOOK_CONVERT: join(root, "missing"), PATH: root },
        "darwin",
        pathBinary,
      ),
    ).toEqual({ ok: false, code: "backend-unavailable" });
  });
});

describe("takio convert", () => {
  it("converts with literal canonical argv and reports verified bytes and digest", async () => {
    const root = await temporaryRoot();
    const input = join(root, "- input;$(touch nope).epub");
    const output = join(root, "- output;still-literal.pdf");
    const invocation = join(root, "invocation.json");
    const bytes = Buffer.from(fakeInput({ record: invocation }));
    await writeFile(input, bytes);

    const result = await runConvert(
      ["--input", input, "--to", "pdf", "--output", output],
      {
        TAKIO_TEST_SECRET: "must-not-reach-backend",
        CI_SECRET: "must-not-reach-backend",
        FAKE_SECRET: "must-not-reach-backend",
      },
    );
    expect(result.exitCode).toBe(0);
    const response = record(result) as {
      ok: true;
      value: { job: { artifact: { path: string; bytes: number; sha256: string } } };
    };
    expect(response.ok).toBe(true);
    expect(response.value.job.artifact).toEqual({
      path: await realpath(output),
      bytes: bytes.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
    expect(await readFile(output)).toEqual(bytes);

    const observed = JSON.parse(await readFile(invocation, "utf8"));
    expect(observed.argv[0]).toBe(await realpath(input));
    expect(basename(observed.argv[1])).toBe("output.pdf");
    expect(observed.argv[1]).not.toContain(input);
    expect(observed.tmpdir).toBe(observed.tmp);
    expect(observed.tmpdir).toBe(observed.temp);
    expect(observed.tmpdir).toContain("takio-convert-");
    expect(observed.environmentKeys).not.toContain("TAKIO_EBOOK_CONVERT");
    expect(observed.environmentKeys).not.toContain("TAKIO_TEST_SECRET");
    expect(observed.environmentKeys).not.toContain("CI_SECRET");
    expect(observed.environmentKeys).not.toContain("FAKE_SECRET");
    await expect(stat(observed.tmpdir)).rejects.toThrow();
    expect(await ownedFiles(root)).toEqual([]);
  });

  for (const [mode, expectedCode] of [
    ["nonzero", "conversion-failed"],
    ["empty", "artifact-invalid"],
    ["symlink", "artifact-invalid"],
  ] as const) {
    it(`rejects a ${mode} backend artifact and cleans up`, async () => {
      const root = await temporaryRoot();
      const input = join(root, "book.epub");
      const output = join(root, "book.pdf");
      await writeFile(input, fakeInput({ mode }));

      const result = await runConvert(
        ["--input", input, "--to", "pdf", "--output", output],
      );
      expect(result.exitCode).toBe(1);
      expect(record(result)).toEqual({ ok: false, error: { code: expectedCode } });
      await expect(stat(output)).rejects.toThrow();
      expect(await ownedFiles(root)).toEqual([]);
    });
  }

  it("kills and reaps a timed-out backend", async () => {
    const root = await temporaryRoot();
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    const finished = join(root, "finished");
    await writeFile(input, fakeInput({ mode: "sleep", finished }));

    const result = await runConvert(
      ["--input", input, "--to", "pdf", "--output", output, "--timeout-seconds", "1"],
    );
    expect(result.exitCode).toBe(1);
    expect(record(result)).toEqual({ ok: false, error: { code: "conversion-timeout" } });
    await expect(stat(output)).rejects.toThrow();
    await expect(stat(finished)).rejects.toThrow();
    expect(await ownedFiles(root)).toEqual([]);
  });

  it("kills and reaps the backend on SIGINT", async () => {
    const root = await temporaryRoot();
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    const started = join(root, "started");
    const finished = join(root, "finished");
    await writeFile(input, fakeInput({ mode: "sleep", started, finished }));

    const child = Bun.spawn(
      ["bun", "run", CLI, "convert", "--input", input, "--to", "pdf", "--output", output],
      {
        env: {
          ...process.env,
          TAKIO_EBOOK_CONVERT: FAKE_BACKEND,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
    expect(exitCode).toBe(1);
    expect(record({ exitCode, stdout, stderr })).toEqual({
      ok: false,
      error: { code: "conversion-cancelled" },
    });
    await expect(stat(output)).rejects.toThrow();
    await expect(stat(finished)).rejects.toThrow();
    expect(await ownedFiles(root)).toEqual([]);
  });

  it("never deletes or rewrites a competitor created after preflight", async () => {
    const root = await temporaryRoot();
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, fakeInput({ raceOutput: output }));

    const result = await runConvert(
      ["--input", input, "--to", "pdf", "--output", output],
    );
    expect(result.exitCode).toBe(1);
    expect(record(result)).toEqual({ ok: false, error: { code: "output-file-exists" } });
    expect(await readFile(output, "utf8")).toBe("competing output");
    expect(await ownedFiles(root)).toEqual([]);
  });

  it("rejects unsupported pairs before starting the backend", async () => {
    const root = await temporaryRoot();
    const input = join(root, "book.pdf");
    const output = join(root, "book.epub");
    const started = join(root, "started");
    await writeFile(input, fakeInput({ started }));

    const result = await runConvert(
      ["--input", input, "--to", "epub", "--output", output],
    );
    expect(result.exitCode).toBe(1);
    expect(record(result)).toEqual({ ok: false, error: { code: "unsupported-conversion" } });
    await expect(stat(started)).rejects.toThrow();
    await expect(stat(output)).rejects.toThrow();
  });

  it("reports empty input arguments and empty source files as invalid arguments", async () => {
    const root = await temporaryRoot();
    const emptyInput = join(root, "empty.epub");
    const output = join(root, "book.pdf");
    await writeFile(emptyInput, "");

    for (const input of ["", emptyInput]) {
      const result = await runConvert([
        "--input",
        input,
        "--to",
        "pdf",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(1);
      expect(record(result)).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
    }
    await expect(stat(output)).rejects.toThrow();
  });

  it("contains workspace setup failures as one JSON error record", async () => {
    const root = await temporaryRoot();
    const input = join(root, "book.epub");
    const output = join(root, "book.pdf");
    await writeFile(input, fakeInput());

    const result = await runConvert(
      ["--input", input, "--to", "pdf", "--output", output],
      { TMPDIR: join(root, "missing", "tmp") },
    );
    expect(result.exitCode).toBe(1);
    expect(record(result)).toEqual({ ok: false, error: { code: "copy-failed" } });
    await expect(stat(output)).rejects.toThrow();
  });
});
