import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";

import type { EbookConvertDiscovery } from "../src/convert.js";
import { createProgram } from "../src/main.js";

const AVAILABLE_BACKEND = {
  ok: true,
  path: "/configured/ebook-convert",
} as const satisfies EbookConvertDiscovery;
const FAKE_EBOOK_META = join(import.meta.dir, "fixtures/fake-ebook-meta.ts");

async function invoke(
  args: string[],
  launch?: (argv: readonly string[]) => void | Promise<void>,
  conversionBackend?: EbookConvertDiscovery,
): Promise<{ output: string[]; exitCode?: number }> {
  const output: string[] = [];
  try {
    await createProgram(
      (line) => output.push(line),
      undefined,
      launch,
      undefined,
      undefined,
      conversionBackend,
    ).parseAsync(["bun", "takio", ...args]);
    return { output };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { output, exitCode: error.exitCode };
    }
    throw error;
  }
}

async function invokeProcess(
  args: string[],
  env: Record<string, string | undefined> = {},
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), ...args],
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function readProcessLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { pending: string },
): Promise<string> {
  for (;;) {
    const newline = state.pending.indexOf("\n");
    if (newline >= 0) {
      const line = state.pending.slice(0, newline).replace(/\r$/, "");
      state.pending = state.pending.slice(newline + 1);
      return line;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Library service closed before returning a response.");
    state.pending += Buffer.from(chunk.value).toString("utf8");
  }
}

function parseOutput(output: string[]): unknown {
  expect(output).toHaveLength(1);
  const line = output[0]!;
  expect(line).not.toContain("\n");
  expect(line).not.toContain("\r");
  return JSON.parse(line);
}

function expectInvalidArgumentsProcess(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): void {
  const expected = { ok: false, error: { code: "invalid-arguments" } };

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(JSON.stringify(expected));
  expect(result.stdout).not.toContain("\n");
  expect(result.stdout).not.toContain("\r");
  expect(result.stdout).not.toMatch(/Usage:|Options:|Commands:|display help|unknown command/);
  expect(JSON.parse(result.stdout)).toEqual(expected);
}

function parseProcessOutput(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): unknown {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const record = result.stdout.trim();
  expect(record).not.toContain("\n");
  expect(record).not.toContain("\r");
  return JSON.parse(record);
}

describe("takio CLI", () => {
  it("lists the built-in format catalogue", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", "formats"]);

    expect(output[0]).toContain("FORMAT");
    expect(output.some((line) => line.startsWith("epub"))).toBe(true);
  });

  it("lists formats through the standard JSON envelope", async () => {
    const result = parseProcessOutput(await invokeProcess(["formats", "--json"])) as {
      value: { formats: { id: string }[] };
    };

    expect(result.value.formats.some(({ id }) => id === "epub")).toBe(true);
  });

  it("describes its machine contract and runtime capabilities in one request", async () => {
    const result = await invoke(
      ["capabilities"],
      undefined,
      AVAILABLE_BACKEND,
    );

    expect(parseOutput(result.output)).toMatchObject({
      ok: true,
      value: {
        cli: { name: "takio", version: "0.1.0" },
        kernel: {
          name: "calibre",
          role: "conversion-kernel",
          verifiedVersion: "9.9.0",
        },
        protocol: {
          version: 2,
          output: "one-json-object",
          structuredInput: ["inline", "stdin", "file"],
          maxRequestBytes: 16 * 1024,
        },
        library: { schemaVersion: 10, backupVersion: 1 },
        backends: { conversion: { name: "ebook-convert", available: true } },
        conversions: {
          available: true,
          pairs: [
            { from: "epub", to: "kepub" },
            { from: "epub", to: "pdf" },
            { from: "epub", to: "azw3" },
            { from: "docx", to: "epub" },
            { from: "html", to: "epub" },
            { from: "txt", to: "epub" },
          ],
          profiles: ["default", "generic_eink", "kindle", "kobo"],
        },
        help: {
          root: "takio --help",
          leaf: "takio <command> --help",
        },
      },
    });
  });

  it("reports an absent conversion kernel as one actionable JSON object", async () => {
    const absent = {
      TAKIO_EBOOK_CONVERT: join(import.meta.dir, "missing-ebook-convert"),
      TAKIO_EBOOK_META: join(import.meta.dir, "missing-ebook-meta"),
      TAKIO_FETCH_EBOOK_METADATA: join(import.meta.dir, "missing-fetch-ebook-metadata"),
      TAKIO_EBOOK_POLISH: join(import.meta.dir, "missing-ebook-polish"),
    };

    const report = parseProcessOutput(await invokeProcess(["doctor"], absent)) as {
      value: {
        status: string;
        kernel: {
          name: string;
          version: string | null;
          missing: string[];
          remediation: { code: string; actions: { command: string }[] } | null;
        };
      };
    };

    expect(report.value.status).toBe("unavailable");
    expect(report.value.kernel.name).toBe("calibre");
    expect(report.value.kernel.version).toBeNull();
    expect(report.value.kernel.missing).toEqual([
      "ebook-convert",
      "ebook-meta",
      "fetch-ebook-metadata",
      "ebook-polish",
    ]);
    expect(report.value.kernel.remediation?.code).toBe("kernel-override-invalid");
    expect(report.value.kernel.remediation?.actions.length).toBeGreaterThan(0);
  });

  it("does not fabricate a plan when no local conversion capability is configured", async () => {
    const result = await invokeProcess(
      ["plan", "--input", "book.epub", "--to", "pdf"],
      { TAKIO_EBOOK_CONVERT: join(import.meta.dir, "missing-ebook-convert") },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "planning-failed" },
    });
  });

  it("plans when the local target declares the exact conversion capability", async () => {
    const result = await invoke(
      ["plan", "--input", "book.epub", "--to", "pdf"],
      undefined,
      AVAILABLE_BACKEND,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.output[0]).toStartWith("Planned job_");
    expect(result.output).toContain("  EPUB → PDF");
    expect(result.output).toContain("  target: This Mac (local)");
  });

  it("reports the assigned target, not the removed device shape, in JSON plans", async () => {
    const result = await invoke(
      ["plan", "--input", "book.epub", "--to", "pdf", "--json"],
      undefined,
      AVAILABLE_BACKEND,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.output).toHaveLength(1);
    const response = JSON.parse(result.output[0]!) as {
      ok: true;
      value: { job: Record<string, unknown> };
    };
    const job = response.value.job;
    expect(job.assignedTarget).toEqual({ id: "local", name: "This Mac" });
    expect("assignedDevice" in job).toBe(false);
  });

  it("lists only the local conversion pairs that are actually configured", async () => {
    expect(await invoke(["devices"])).toEqual({
      output: [
        "ID     STATUS  NAME      CONVERSIONS",
        "local  online  This Mac  epub→kepub",
      ],
    });

    expect(
      await invoke(["devices"], undefined, AVAILABLE_BACKEND),
    ).toEqual({
      output: [
        "ID     STATUS  NAME      CONVERSIONS",
        "local  online  This Mac  epub→kepub, epub→pdf, epub→azw3, docx→epub, html→epub, txt→epub",
      ],
    });

    const response = await invoke(["devices", "--json"], undefined, AVAILABLE_BACKEND);
    expect(JSON.parse(response.output[0]!)).toMatchObject({
      ok: true,
      value: {
        devices: [{
          id: "local",
          capabilities: [
            { from: "epub", to: "kepub" },
            { from: "epub", to: "pdf" },
            { from: "epub", to: "azw3" },
            { from: "docx", to: "epub" },
            { from: "html", to: "epub" },
            { from: "txt", to: "epub" },
          ],
        }],
      },
    });
  });

  it("reports an unsupported --to value without exposing a validation stack trace", async () => {
    const result = await invokeProcess([
      "plan",
      "--input",
      "book.epub",
      "--to",
      "nonsense",
    ]);

    expectInvalidArgumentsProcess(result);
  });

  it("reports an empty --input as a stable planning error without a schema stack", async () => {
    const result = await invokeProcess(
      ["plan", "--input", "", "--to", "pdf"],
      { TAKIO_EBOOK_CONVERT: join(import.meta.dir, "missing-ebook-convert") },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "planning-failed" },
    });
  });

  it("shows stateful command-group help", async () => {
    const result = await invokeProcess(["library", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio library [options] [command]");
    expect(result.stdout).toContain("Manage a durable local library");
    expect(result.stdout).toContain("query");
    expect(result.stdout).not.toContain('"ok":false');
  });

  it("shows actionable leaf help without a JSON failure", async () => {
    const result = await invokeProcess(["library", "query", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio library query [options]");
    expect(result.stdout).toContain("--request-json <json>");
    expect(result.stdout).not.toContain('"ok":false');
  });

  it("supports nested help commands", async () => {
    const result = await invokeProcess(["library", "help", "query"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio library query [options]");
    expect(result.stdout).toContain("--request-json <json>");
  });

  it("reports an unknown library command as JSON without Commander prose", async () => {
    expectInvalidArgumentsProcess(await invokeProcess(["library", "nope"]));
  });

  it("preserves root help", async () => {
    const result = await invokeProcess(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio [options] [command]");
    expect(result.stdout).toContain("Options:");
    expect(result.stdout).toContain("Commands:");
  });

  it("reports invalid top-level arguments through the standard JSON envelope", async () => {
    const result = await invokeProcess(["plan"]);

    expectInvalidArgumentsProcess(result);
  });

  it("reports unknown top-level commands through the standard JSON envelope", async () => {
    const result = await invokeProcess(["nope"]);

    expectInvalidArgumentsProcess(result);
  });

  describe("library storage", () => {
    let directory: string | undefined;
    let databasePath: string | undefined;
    let previousDataDirectory: string | undefined;
    let previousEbookMeta: string | undefined;

    beforeEach(async () => {
      directory = undefined;
      databasePath = undefined;
      previousDataDirectory = process.env.TAKIO_DATA_DIR;
      previousEbookMeta = process.env.TAKIO_EBOOK_META;
      directory = await mkdtemp(join(tmpdir(), "takio-cli-"));
      databasePath = join(directory, "library.sqlite");
      process.env.TAKIO_EBOOK_META = join(directory, "missing-ebook-meta");
    });

    afterEach(async () => {
      if (previousDataDirectory === undefined) {
        delete process.env.TAKIO_DATA_DIR;
      } else {
        process.env.TAKIO_DATA_DIR = previousDataDirectory;
      }
      if (previousEbookMeta === undefined) {
        delete process.env.TAKIO_EBOOK_META;
      } else {
        process.env.TAKIO_EBOOK_META = previousEbookMeta;
      }
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    });

    async function addItem(id: string, sourcePath: string, format = "epub"): Promise<void> {
      const result = await invoke([
        "library",
        "add",
        "--db",
        databasePath!,
        "--id",
        id,
        "--title",
        id,
        "--source-path",
        sourcePath,
        "--format",
        format,
        "--added-at",
        "2026-07-18T12:00:00.000Z",
      ]);
      expect(result.exitCode).toBeUndefined();
    }

    it("uses the isolated production layout when --db is omitted", async () => {
      process.env.TAKIO_DATA_DIR = directory!;

      const listed = await invoke(["library", "list"]);

      expect(listed.exitCode).toBeUndefined();
      expect(parseOutput(listed.output)).toEqual({ ok: true, value: { items: [] } });
      expect(await Bun.file(join(directory!, "library.sqlite")).exists()).toBe(true);
    });

    it("keeps named libraries isolated and rejects an ambiguous explicit database", async () => {
      const sourcePath = join(directory!, "named-library.epub");
      const explicitDatabase = join(directory!, "must-not-open.sqlite");
      await Bun.write(sourcePath, "named library contents");
      const env = { TAKIO_DATA_DIR: directory };

      const imported = parseProcessOutput(await invokeProcess([
        "--library",
        "fiction",
        "library",
        "import",
        "--source-path",
        sourcePath,
      ], env)) as { ok: true; value: { item: { id: string } } };
      const named = parseProcessOutput(await invokeProcess([
        "--library",
        "fiction",
        "library",
        "list",
      ], env)) as { ok: true; value: { items: Array<{ id: string }> } };
      const unnamed = parseProcessOutput(await invokeProcess(["library", "list"], env));

      expect(named.value.items.map(({ id }) => id)).toEqual([imported.value.item.id]);
      expect(unnamed).toEqual({ ok: true, value: { items: [] } });
      expect(await Bun.file(join(directory!, "libraries", "fiction", "library.sqlite")).exists()).toBe(true);
      expectInvalidArgumentsProcess(await invokeProcess([
        "--library",
        "fiction",
        "library",
        "list",
        "--db",
        explicitDatabase,
      ], env));
      expect(await Bun.file(explicitDatabase).exists()).toBe(false);
    });

    it("keeps the filename fallback without a metadata backend across the process protocol", async () => {
      const sourcePath = join(directory!, "process-book.epub");
      await Bun.write(sourcePath, "process owned contents");
      const env = { TAKIO_DATA_DIR: directory };

      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as {
        ok: true;
        value: {
          item: {
            id: string;
            title: string;
            sourcePath: string;
            format: string;
            addedAt: string;
            formats: {
              sourcePath: string;
              format: string;
              addedAt: string;
              provenance: string;
            }[];
          };
        };
      };
      expect(imported.value.item.title).toBe("process-book");
      expect(imported.value.item.formats).toEqual([
        {
          sourcePath: imported.value.item.sourcePath,
          format: imported.value.item.format,
          addedAt: imported.value.item.addedAt,
          provenance: "managed",
        },
      ]);

      const listed = parseProcessOutput(
        await invokeProcess(["library", "list"], env),
      ) as { ok: true; value: { items: Array<typeof imported.value.item> } };
      expect(listed.value.items[0]?.formats).toEqual(imported.value.item.formats);
      expect(listed).toEqual({ ok: true, value: { items: [imported.value.item] } });

      expect(
        parseProcessOutput(
          await invokeProcess(["library", "remove", "--id", imported.value.item.id], env),
        ),
      ).toEqual({
        ok: true,
        value: { item: imported.value.item, cleanupPending: false },
      });
    });

    it("processes strict library service updates sequentially and preserves one-shot updates", async () => {
      const sourcePath = join(directory!, "service-book.epub");
      await Bun.write(sourcePath, "service contents");
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { ok: true; value: { item: { id: string } } };
      const itemId = imported.value.item.id;

      const first = { id: "req-1", command: "library_update", args: { id: itemId, patch: { title: "First" } } };
      const second = { id: "req-2", command: "library_update", args: { id: itemId, patch: { title: "Second" } } };
      const service = await invokeProcess(["library", "service"], env, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
      expect(service.exitCode).toBe(0);
      expect(service.stderr).toBe("");
      const responses = service.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(responses.map((response) => [response.id, response.ok, response.value.item.title])).toEqual([
        ["req-1", true, "First"],
        ["req-2", true, "Second"],
      ]);

      const updated = parseProcessOutput(
        await invokeProcess(["library", "update", "--id", itemId, "--patch-json", JSON.stringify({ title: "Third" })], env),
      ) as { ok: true; value: { item: { title: string } } };
      expect(updated.value.item.title).toBe("Third");

      const restarted = { id: "req-3", command: "library_update", args: { id: itemId, patch: { title: "Fourth" } } };
      const restartedService = await invokeProcess(["library", "service"], env, `${JSON.stringify(restarted)}\n`);
      expect(restartedService.exitCode).toBe(0);
      expect(JSON.parse(restartedService.stdout.trim())).toMatchObject({
        id: "req-3",
        ok: true,
        value: { item: { title: "Fourth" } },
      });
      const persisted = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", itemId], env),
      ) as { ok: true; value: { item: { title: string } } };
      expect(persisted.value.item.title).toBe("Fourth");
    });

    it("coordinates an open library service with a foreground CLI writer", async () => {
      const sourcePath = join(directory!, "coordinated-service-book.epub");
      await Bun.write(sourcePath, "coordinated service contents");
      const env = { ...process.env, TAKIO_DATA_DIR: directory! };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { ok: true; value: { item: { id: string } } };
      const itemId = imported.value.item.id;
      const service = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), "library", "service"],
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = service.stdout.getReader();
      const output = { pending: "" };

      service.stdin.write(`${JSON.stringify({ id: "service-1", command: "library_update", args: { id: itemId, patch: { title: "Service One" } } })}\n`);
      expect(JSON.parse(await readProcessLine(reader, output))).toMatchObject({
        id: "service-1",
        ok: true,
        value: { item: { title: "Service One" } },
      });

      const foreground = parseProcessOutput(
        await invokeProcess(["library", "update", "--id", itemId, "--patch-json", JSON.stringify({ title: "Foreground" })], env),
      ) as { ok: true; value: { item: { title: string } } };
      expect(foreground.value.item.title).toBe("Foreground");

      service.stdin.write(`${JSON.stringify({ id: "service-2", command: "library_update", args: { id: itemId, patch: { title: "Service Two" } } })}\n`);
      expect(JSON.parse(await readProcessLine(reader, output))).toMatchObject({
        id: "service-2",
        ok: true,
        value: { item: { title: "Service Two" } },
      });
      service.stdin.end();
      expect(await service.exited).toBe(0);
      expect(await new Response(service.stderr).text()).toBe("");

      const persisted = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", itemId], env),
      ) as { ok: true; value: { item: { title: string } } };
      expect(persisted.value.item.title).toBe("Service Two");
    });

    it("rejects non-strict library service protocol and does not leak startup errors", async () => {
      const env = { TAKIO_DATA_DIR: directory };
      const extra = { id: "req-1", command: "library_update", args: { id: "missing", patch: { title: "No" }, extra: true } };
      const invalid = await invokeProcess(["library", "service"], env, `${JSON.stringify(extra)}\n`);
      expect(invalid.exitCode).toBe(0);
      expect(JSON.parse(invalid.stdout.trim())).toEqual({ id: "req-1", ok: false, error: { code: "invalid-arguments" } });

      const blockedPath = join(directory!, "missing", "library.sqlite");
      await Bun.write(join(directory!, "missing"), "not a directory");
      const startup = await invokeProcess(["library", "service", "--db", blockedPath], {}, "");
      expect(startup.exitCode).not.toBe(0);
      expect(startup.stdout.trim()).toBe(JSON.stringify({ id: "", ok: false, error: { code: "storage-unavailable" } }));
      expect(startup.stdout).not.toContain(blockedPath);
    });

    it("enriches a single import while preserving an explicit title", async () => {
      const sourcePath = join(directory!, "single-metadata.epub");
      await Bun.write(
        sourcePath,
        JSON.stringify({
          fakeEbookMeta: {
            opf: `<package><metadata>
              <dc:title>Extracted title</dc:title>
              <dc:creator opf:role="aut">Extracted Author</dc:creator>
            </metadata></package>`,
          },
        }),
      );
      const env = {
        TAKIO_DATA_DIR: directory,
        TAKIO_EBOOK_META: FAKE_EBOOK_META,
      };

      const imported = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "import",
            "--source-path",
            sourcePath,
            "--title",
            "Explicit title",
          ],
          env,
        ),
      ) as {
        ok: true;
        value: {
          item: {
            id: string;
            title: string;
            authors?: Array<{ name: string }>;
          };
        };
      };

      expect(imported.value.item).toMatchObject({
        title: "Explicit title",
        authors: [{ name: "Extracted Author" }],
      });
      const reopened = parseProcessOutput(
        await invokeProcess(
          ["library", "get", "--id", imported.value.item.id],
          env,
        ),
      ) as {
        ok: true;
        value: { item: { title: string; authors?: Array<{ name: string }> } };
      };
      expect(reopened.value.item).toMatchObject({
        title: "Explicit title",
        authors: [{ name: "Extracted Author" }],
      });
    });

    it("recursively imports repeated roots in caller order with every outcome accounted for", async () => {
      const root = join(directory!, "batch roots [literal]");
      const nested = join(root, "nested");
      await mkdir(nested, { recursive: true });
      const importedPath = join(root, "a.epub");
      const skippedPath = join(root, "b.bin");
      const nestedImportedPath = join(nested, "c.pdf");
      const duplicatePath = join(directory!, "duplicate.epub");
      const missingPath = join(directory!, "missing.epub");
      const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const duplicateContents = JSON.stringify({
        fakeEbookMeta: {
          opf: `<package><metadata>
            <dc:title>First embedded title</dc:title>
            <dc:creator opf:role="aut">First Author</dc:creator>
          </metadata></package>`,
          coverBase64: cover.toString("base64"),
        },
      });
      await Bun.write(importedPath, duplicateContents);
      await Bun.write(skippedPath, "unsupported contents");
      await Bun.write(
        nestedImportedPath,
        JSON.stringify({
          fakeEbookMeta: {
            opf: "<package><metadata><dc:title>Second embedded title</dc:title></metadata></package>",
          },
        }),
      );
      await Bun.write(duplicatePath, duplicateContents);
      const env = {
        TAKIO_DATA_DIR: directory,
        TAKIO_EBOOK_META: FAKE_EBOOK_META,
      };

      const imported = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "import-many",
            "--source-path",
            missingPath,
            "--source-path",
            root,
            "--source-path",
            duplicatePath,
          ],
          env,
        ),
      ) as {
        ok: true;
        value: {
          outcomes: Array<{
            status: string;
            sourcePath: string;
            item?: {
              id: string;
              title: string;
              authors?: Array<{ name: string }>;
              coverPath?: string;
            };
          }>;
          counts: {
            total: number;
            imported: number;
            skipped: number;
            duplicates: number;
            failed: number;
          };
        };
      };
      const firstItem = imported.value.outcomes[1]?.item;
      const nestedItem = imported.value.outcomes[3]?.item;
      expect(firstItem).toBeDefined();
      expect(nestedItem).toBeDefined();
      expect(imported).toEqual({
        ok: true,
        value: {
          outcomes: [
            { status: "failed", sourcePath: missingPath, code: "not-found" },
            {
              status: "imported",
              sourcePath: importedPath,
              item: firstItem,
            },
            {
              status: "skipped",
              sourcePath: skippedPath,
              reason: "unsupported-format",
            },
            {
              status: "imported",
              sourcePath: nestedImportedPath,
              item: nestedItem,
            },
            {
              status: "duplicate",
              sourcePath: duplicatePath,
              existing: { itemId: firstItem!.id, format: "epub" },
              reason: "earlier-in-request",
            },
          ],
          counts: { total: 5, imported: 2, skipped: 1, duplicates: 1, failed: 1 },
        },
      });
      expect(firstItem).toMatchObject({
        title: "First embedded title",
        authors: [{ name: "First Author" }],
      });
      expect(nestedItem!.title).toBe("Second embedded title");
      expect(firstItem!.coverPath).toBeDefined();
      expect(Buffer.from(await Bun.file(firstItem!.coverPath!).arrayBuffer())).toEqual(cover);
    });

    it("rejects zero or more than 256 batch roots before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "batch-storage-blocked");
      await Bun.write(blockedDataDirectory, "storage must not open");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };

      expectInvalidArgumentsProcess(
        await invokeProcess(["library", "import-many"], env),
      );
      expectInvalidArgumentsProcess(
        await invokeProcess(
          [
            "library",
            "import-many",
            ...Array.from({ length: 257 }, (_, index) => [
              "--source-path",
              join(directory!, `root-${index}`),
            ]).flat(),
          ],
          env,
        ),
      );
    });

    it("rejects invalid export JSON before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "export-storage-blocked");
      await Bun.write(blockedDataDirectory, "storage must not open");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };
      const destinationPath = join(directory!, "exports");
      const oversizedRequest = JSON.stringify({
        ids: ["book-1"],
        destinationPath: "é".repeat(8_192),
      });
      expect(oversizedRequest.length).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(oversizedRequest, "utf8")).toBeGreaterThan(
        16 * 1024,
      );

      const invalidRequests = [
        "",
        "{",
        "[]",
        JSON.stringify({ ids: [], destinationPath }),
        JSON.stringify({
          ids: Array.from({ length: 257 }, (_, index) => `book-${index}`),
          destinationPath,
        }),
        JSON.stringify({ ids: ["book-1", "book-1"], destinationPath }),
        JSON.stringify({ ids: ["   "], destinationPath }),
        JSON.stringify({ ids: ["book-1"], destinationPath: "   " }),
        JSON.stringify({ ids: ["book-1"], destinationPath, fileNameTemplate: "author/title" }),
        JSON.stringify({ ids: ["book-1"], destinationPath, unexpected: true }),
        oversizedRequest,
      ];

      expectInvalidArgumentsProcess(
        await invokeProcess(["library", "export-many"], env),
      );
      for (const request of invalidRequests) {
        expectInvalidArgumentsProcess(
          await invokeProcess(
            ["library", "export-many", "--request-json", request],
            env,
          ),
        );
      }
    });

    it("exports a valid request as one exact process report", async () => {
      const sourceContents = "export protocol contents";
      const sourcePath = join(directory!, "export-protocol.epub");
      const destinationDirectory = join(directory!, "export destination");
      await Promise.all([
        Bun.write(sourcePath, sourceContents),
        mkdir(destinationDirectory),
      ]);
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(
          ["library", "import", "--source-path", sourcePath],
          env,
        ),
      ) as {
        ok: true;
        value: { item: { id: string; title: string } };
      };
      const item = imported.value.item;
      expect(
        parseProcessOutput(
          await invokeProcess(
            [
              "library",
              "update",
              "--id",
              item.id,
              "--patch-json",
              JSON.stringify({ authors: [{ name: "CLI Author" }] }),
            ],
            env,
          ),
        ),
      ).toMatchObject({ ok: true, value: { item: { author: "CLI Author" } } });
      const itemHash = new Bun.CryptoHasher("sha256")
        .update(item.id)
        .digest("hex");
      const exportedPath = join(
        await realpath(destinationDirectory),
        `CLI Author - ${item.title} [${itemHash}].epub`,
      );
      const expected = {
        ok: true,
        value: {
          outcomes: [
            {
              status: "exported",
              itemId: item.id,
              format: "epub",
              provenance: "managed",
              destinationPath: exportedPath,
              bytes: Buffer.byteLength(`${sourceContents}\nembedded metadata`),
              sha256: new Bun.CryptoHasher("sha256")
                .update(`${sourceContents}\nembedded metadata`)
                .digest("hex"),
              metadata: "embedded",
            },
            {
              status: "failed",
              itemId: "missing-export-item",
              code: "item-not-found",
            },
          ],
          counts: { total: 2, exported: 1, skipped: 0, failed: 1 },
        },
      };

      const result = await invokeProcess(
        [
          "library",
          "export-many",
          "--request-json",
          JSON.stringify({
            ids: [item.id, "missing-export-item"],
            destinationPath: destinationDirectory,
            fileNameTemplate: "author-title",
          }),
        ],
        { ...env, TAKIO_EBOOK_META: FAKE_EBOOK_META },
      );

      expect(parseProcessOutput(result)).toEqual(expected);
      expect(await Bun.file(exportedPath).text()).toBe(`${sourceContents}\nembedded metadata`);
      expect(await Bun.file(sourcePath).text()).toBe(sourceContents);
    });

    it("removes an export copy when metadata materialization fails", async () => {
      const sourcePath = join(directory!, "metadata-failure.epub");
      const destinationDirectory = join(directory!, "failed export destination");
      const sourceContents = JSON.stringify({ fakeEbookMeta: { mode: "nonzero" } });
      await Promise.all([Bun.write(sourcePath, sourceContents), mkdir(destinationDirectory)]);
      const env = { TAKIO_DATA_DIR: directory };
      const id = "metadata-failure";
      const title = "Metadata failure";
      const added = parseProcessOutput(await invokeProcess([
        "library",
        "add",
        "--id",
        id,
        "--title",
        title,
        "--source-path",
        sourcePath,
        "--format",
        "epub",
        "--added-at",
        "2026-07-31T00:00:00.000Z",
      ], env));
      expect(added).toMatchObject({ ok: true });

      const result = parseProcessOutput(await invokeProcess(
        [
          "library",
          "export-many",
          "--request-json",
          JSON.stringify({ ids: [id], destinationPath: destinationDirectory }),
        ],
        { ...env, TAKIO_EBOOK_META: FAKE_EBOOK_META },
      ));
      const destinationPath = join(
        await realpath(destinationDirectory),
        `${title} [${new Bun.CryptoHasher("sha256").update(id).digest("hex")}].epub`,
      );

      expect(result).toEqual({
        ok: true,
        value: {
          outcomes: [{
            status: "failed",
            itemId: id,
            format: "epub",
            provenance: "referenced",
            destinationPath,
            code: "metadata-write-failed",
          }],
          counts: { total: 1, exported: 0, skipped: 0, failed: 1 },
        },
      });
      expect(await Bun.file(destinationPath).exists()).toBe(false);
      expect(await Bun.file(sourcePath).text()).toBe(sourceContents);
    });

    it("updates a bounded set with every item accounted for", async () => {
      const firstPath = join(directory!, "batch-update-first.epub");
      const secondPath = join(directory!, "batch-update-second.epub");
      await Promise.all([
        Bun.write(firstPath, "first batch update contents"),
        Bun.write(secondPath, "second batch update contents"),
      ]);
      await addItem("batch-update-first", firstPath);
      await addItem("batch-update-second", secondPath);

      const result = parseProcessOutput(await invokeProcess([
        "library",
        "update-many",
        "--db",
        databasePath!,
        "--id",
        "batch-update-first",
        "--id",
        "missing-batch-update",
        "--id",
        "batch-update-second",
        "--patch-json",
        JSON.stringify({ publisher: "Batch Publisher", tags: ["Reviewed"] }),
      ])) as {
        ok: true;
        value: {
          outcomes: Array<{ status: string; itemId: string; item?: { publisher?: string; tags: string[] } }>;
          counts: { total: number; updated: number; missing: number; failed: number };
        };
      };

      expect(result.value.counts).toEqual({ total: 3, updated: 2, missing: 1, failed: 0 });
      expect(result.value.outcomes.map(({ status, itemId }) => ({ status, itemId }))).toEqual([
        { status: "updated", itemId: "batch-update-first" },
        { status: "missing", itemId: "missing-batch-update" },
        { status: "updated", itemId: "batch-update-second" },
      ]);
      expect(result.value.outcomes[0]?.item).toMatchObject({
        publisher: "Batch Publisher",
        tags: ["Reviewed"],
      });
      expect(result.value.outcomes[2]?.item).toMatchObject({
        publisher: "Batch Publisher",
        tags: ["Reviewed"],
      });
    });

    it("rejects an oversized metadata batch before opening storage", async () => {
      const blockedDataDirectory = join(directory!, "update-many-storage-blocked");
      await Bun.write(blockedDataDirectory, "storage must not open");
      const ids = Array.from({ length: 257 }, (_, index) => ["--id", `book-${index}`]).flat();

      expectInvalidArgumentsProcess(await invokeProcess([
        "library",
        "update-many",
        ...ids,
        "--patch-json",
        JSON.stringify({ tags: ["Reviewed"] }),
      ], { TAKIO_DATA_DIR: blockedDataDirectory }));
    });

    it("trashes, lists, restores, and purges through the strict process protocol", async () => {
      const sourcePath = join(directory!, "trash-process-book.epub");
      await Bun.write(sourcePath, "trash process contents");
      const env = { TAKIO_DATA_DIR: directory };
      const request = { id: "" };

      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { ok: true; value: { item: { id: string; sourcePath: string } } };
      const item = imported.value.item;
      request.id = item.id;

      expect(
        parseProcessOutput(
          await invokeProcess(
            ["library", "trash", "move", "--request-json", JSON.stringify(request)],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { item } });
      expect(
        parseProcessOutput(await invokeProcess(["library", "list"], env)),
      ).toEqual({ ok: true, value: { items: [] } });

      const page = { offset: 0, limit: 1 };
      expect(
        parseProcessOutput(
          await invokeProcess(
            [
              "library",
              "trash",
              "list",
              "--request-json",
              JSON.stringify({ page }),
            ],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { items: [item], total: 1, page } });

      expect(
        parseProcessOutput(
          await invokeProcess(
            ["library", "trash", "restore", "--request-json", JSON.stringify(request)],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { item } });
      expect(
        parseProcessOutput(
          await invokeProcess(
            [
              "library",
              "trash",
              "list",
              "--request-json",
              JSON.stringify({ page }),
            ],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { items: [], total: 0, page } });

      expect(
        parseProcessOutput(
          await invokeProcess(
            ["library", "trash", "move", "--request-json", JSON.stringify(request)],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { item } });
      expect(
        parseProcessOutput(
          await invokeProcess(
            ["library", "trash", "purge", "--request-json", JSON.stringify(request)],
            env,
          ),
        ),
      ).toEqual({ ok: true, value: { item, cleanupPending: false } });
      expect(
        parseProcessOutput(
          await invokeProcess(
            ["library", "trash", "purge", "--request-json", JSON.stringify(request)],
            env,
          ),
        ),
      ).toEqual({
        ok: true,
        value: { item: null, cleanupPending: false },
      });
    });

    it("reviews, reopens, and merges duplicate pairs through the strict process protocol", async () => {
      const leftPath = join(directory!, "duplicate-left.epub");
      const rightPath = join(directory!, "duplicate-right.epub");
      await Promise.all([
        Bun.write(leftPath, "shared duplicate contents"),
        Bun.write(rightPath, "shared duplicate contents"),
      ]);
      await addItem("duplicate-left", leftPath);
      await addItem("duplicate-right", rightPath);

      const page = { offset: 0, limit: 10 };
      const runDuplicateCommand = async (action: string, request: unknown) =>
        invokeProcess([
          "library",
          "duplicates",
          action,
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify(request),
        ]);
      const list = async (disposition: "kept-both" | "unreviewed") =>
        parseProcessOutput(
          await runDuplicateCommand("list", { page, disposition }),
        ) as {
          ok: true;
          value: {
            candidates: Array<{
              left: { id: string; tags: string[] };
              right: { id: string };
              reviewToken: string;
            }>;
            total: number;
            page: typeof page;
            scan: {
              filesHashed: number;
              fingerprintsReused: number;
              unreadableFormats: number;
            };
          };
        };

      const initial = await list("unreviewed");
      expect(initial.ok).toBe(true);
      expect(initial.value.page).toEqual(page);
      expect(initial.value.total).toBe(1);
      expect(initial.value.candidates).toHaveLength(1);
      expect(Object.keys(initial.value).sort()).toEqual([
        "candidates",
        "page",
        "scan",
        "total",
      ]);
      const candidate = initial.value.candidates[0]!;
      expect([candidate.left.id, candidate.right.id]).toEqual([
        "duplicate-left",
        "duplicate-right",
      ]);
      const pairRequest = {
        leftId: candidate.left.id,
        rightId: candidate.right.id,
        reviewToken: candidate.reviewToken,
      };

      expect(
        parseProcessOutput(await runDuplicateCommand("keep", pairRequest)),
      ).toEqual({ ok: true, value: null });
      expect((await list("unreviewed")).value.candidates).toEqual([]);
      expect((await list("kept-both")).value.candidates).toHaveLength(1);

      expect(
        parseProcessOutput(await runDuplicateCommand("reopen", pairRequest)),
      ).toEqual({ ok: true, value: null });
      expect((await list("unreviewed")).value.candidates).toHaveLength(1);

      const stale = await runDuplicateCommand("keep", {
        ...pairRequest,
        reviewToken: "0".repeat(64),
      });
      expect(stale.exitCode).not.toBe(0);
      expect(stale.stderr).toBe("");
      expect(JSON.parse(stale.stdout)).toEqual({
        ok: false,
        error: { code: "stale-review" },
      });

      const merged = parseProcessOutput(
        await runDuplicateCommand("merge", {
          targetId: candidate.left.id,
          sourceId: candidate.right.id,
          reviewToken: candidate.reviewToken,
          metadata: { tags: candidate.left.tags },
          addSourceFormats: [],
          cover: "target",
        }),
      ) as {
        ok: true;
        value: {
          target: { id: string };
          trashedSource: { id: string };
          cleanupPending: boolean;
        };
      };
      expect(merged.value.target.id).toBe(candidate.left.id);
      expect(merged.value.trashedSource.id).toBe(candidate.right.id);
      expect(merged.value.cleanupPending).toBe(false);
      expect(Object.keys(merged.value).sort()).toEqual([
        "cleanupPending",
        "target",
        "trashedSource",
      ]);
      expect((await list("unreviewed")).value.candidates).toEqual([]);

      const active = parseProcessOutput(
        await invokeProcess(["library", "list", "--db", databasePath!]),
      ) as { value: { items: Array<{ id: string }> } };
      expect(active.value.items.map(({ id }) => id)).toEqual([candidate.left.id]);
      const trash = parseProcessOutput(
        await invokeProcess([
          "library",
          "trash",
          "list",
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify({ page }),
        ]),
      ) as { value: { items: Array<{ id: string }> } };
      expect(trash.value.items.map(({ id }) => id)).toEqual([candidate.right.id]);
    });

    it("refuses to purge an active item without changing remove semantics", async () => {
      const sourcePath = join(directory!, "active-purge.epub");
      await Bun.write(sourcePath, "active purge contents");
      await addItem("active-purge", sourcePath);

      const purged = await invoke([
        "library",
        "trash",
        "purge",
        "--db",
        databasePath!,
        "--request-json",
        JSON.stringify({ id: "active-purge" }),
      ]);

      expect(purged.exitCode).toBe(1);
      expect(parseOutput(purged.output)).toEqual({
        ok: false,
        error: { code: "not-trashed" },
      });
      const listed = await invoke(["library", "list", "--db", databasePath!]);
      expect(
        (parseOutput(listed.output) as { value: { items: { id: string }[] } }).value.items,
      ).toMatchObject([{ id: "active-purge" }]);
    });

    it("adds and durably lists an item through separate invocations", async () => {
      const item = {
        id: "book-1",
        title: "The Left Hand of Darkness",
        sourcePath: "library/left-hand.epub",
        format: "epub",
        addedAt: "2026-07-18T12:00:00.000Z",
        formats: [
          {
            sourcePath: "library/left-hand.epub",
            format: "epub",
            addedAt: "2026-07-18T12:00:00.000Z",
            provenance: "referenced",
          },
        ],
        tags: [],
      };
      const added = await invoke([
        "library",
        "add",
        "--db",
        databasePath!,
        "--id",
        item.id,
        "--title",
        item.title,
        "--source-path",
        item.sourcePath,
        "--format",
        item.format,
        "--added-at",
        item.addedAt,
      ]);

      expect(added.exitCode).toBeUndefined();
      expect(parseOutput(added.output)).toEqual({ ok: true, value: { item } });

      const listed = await invoke(["library", "list", "--db", databasePath!]);
      expect(listed.exitCode).toBeUndefined();
      expect(parseOutput(listed.output)).toEqual({ ok: true, value: { items: [item] } });
    });

    it("opens a regular declared-format file with an exact platform argv array", async () => {
      const sourcePath = join(directory!, "book with spaces.epub");
      await Bun.write(sourcePath, "book contents");
      await addItem("open-book", sourcePath);
      const launches: string[][] = [];
      const launch = (argv: readonly string[]): void => {
        launches.push([...argv]);
      };

      const opened = await invoke(
        ["library", "open", "--db", databasePath!, "--id", "open-book", "--json"],
        launch,
      );

      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer.exe"
            : "xdg-open";
      expect(opened.exitCode).toBeUndefined();
      expect(parseOutput(opened.output)).toEqual({
        ok: true,
        value: { id: "open-book", format: "epub", path: sourcePath },
      });
      expect(launches).toEqual([[opener, sourcePath]]);

      const human = await invoke(
        ["library", "open", "--db", databasePath!, "--id", "open-book"],
        launch,
      );
      expect(human).toEqual({ output: [`Opened ${sourcePath}`] });
    });

    it("opens the exact requested secondary format instead of the primary format", async () => {
      const epubPath = join(directory!, "multi-format.epub");
      const pdfPath = join(directory!, "multi-format.pdf");
      await Bun.write(epubPath, "epub contents");
      await Bun.write(pdfPath, "pdf contents");
      const canonicalPdfPath = await realpath(pdfPath);
      await addItem("multi-format", epubPath);
      const attached = await invoke([
        "library",
        "format",
        "attach",
        "--db",
        databasePath!,
        "--id",
        "multi-format",
        "--source-path",
        pdfPath,
      ]);
      expect(attached.exitCode).toBeUndefined();
      const launches: string[][] = [];

      const opened = await invoke(
        [
          "library",
          "open",
          "--db",
          databasePath!,
          "--id",
          "multi-format",
          "--format",
          "pdf",
          "--json",
        ],
        (argv) => launches.push([...argv]),
      );

      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer.exe"
            : "xdg-open";
      expect(opened.exitCode).toBeUndefined();
      expect(parseOutput(opened.output)).toEqual({
        ok: true,
        value: { id: "multi-format", format: "pdf", path: canonicalPdfPath },
      });
      expect(launches).toEqual([[opener, canonicalPdfPath]]);
    });

    it("does not open another format when the requested format is missing", async () => {
      const epubPath = join(directory!, "single-format.epub");
      await Bun.write(epubPath, "epub contents");
      await addItem("single-format", epubPath);
      const launches: string[][] = [];

      const result = await invoke(
        [
          "library",
          "open",
          "--db",
          databasePath!,
          "--id",
          "single-format",
          "--format",
          "pdf",
          "--json",
        ],
        (argv) => launches.push([...argv]),
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "format-not-found" },
      });
      expect(launches).toEqual([]);
    });

    it("rejects an unsupported requested format without opening the primary format", async () => {
      const epubPath = join(directory!, "unsupported-request.epub");
      await Bun.write(epubPath, "epub contents");
      await addItem("unsupported-request", epubPath);
      const launches: string[][] = [];

      const result = await invoke(
        [
          "library",
          "open",
          "--db",
          databasePath!,
          "--id",
          "unsupported-request",
          "--format",
          "rtf",
          "--json",
        ],
        (argv) => launches.push([...argv]),
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
      expect(launches).toEqual([]);
    });

    it("reports a missing selected secondary without opening the healthy primary", async () => {
      const epubPath = join(directory!, "healthy-primary.epub");
      const pdfPath = join(directory!, "missing-secondary.pdf");
      await Bun.write(epubPath, "epub contents");
      await Bun.write(pdfPath, "pdf contents");
      await addItem("missing-secondary", epubPath);
      const attached = await invoke([
        "library",
        "format",
        "attach",
        "--db",
        databasePath!,
        "--id",
        "missing-secondary",
        "--source-path",
        pdfPath,
      ]);
      expect(attached.exitCode).toBeUndefined();
      await rm(pdfPath);
      const launches: string[][] = [];

      const result = await invoke(
        [
          "library",
          "open",
          "--db",
          databasePath!,
          "--id",
          "missing-secondary",
          "--format",
          "pdf",
          "--json",
        ],
        (argv) => launches.push([...argv]),
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "missing-file" },
      });
      expect(launches).toEqual([]);
    });

    it("reports not-found without launching for an unknown item", async () => {
      const result = await invoke(
        ["library", "open", "--db", databasePath!, "--id", "missing", "--json"],
        () => {
          throw new Error("launcher must not be called");
        },
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "not-found" },
      });
    });

    it("reports missing-file for absent and non-regular sources without launching", async () => {
      const missingPath = join(directory!, "missing.epub");
      const directoryPath = join(directory!, "directory.epub");
      await mkdir(directoryPath);
      await addItem("missing-file", missingPath);
      await addItem("directory", directoryPath);

      for (const id of ["missing-file", "directory"]) {
        const result = await invoke(
          ["library", "open", "--db", databasePath!, "--id", id, "--json"],
          () => {
            throw new Error("launcher must not be called");
          },
        );
        expect(result.exitCode).toBe(1);
        expect(parseOutput(result.output)).toEqual({
          ok: false,
          error: { code: "missing-file" },
        });
      }
    });

    it("rejects a source extension outside its declared format before launching", async () => {
      const sourcePath = join(directory!, "tampered.sh");
      await Bun.write(sourcePath, "#!/bin/sh");
      await addItem("tampered", sourcePath, "epub");

      const result = await invoke(
        ["library", "open", "--db", databasePath!, "--id", "tampered", "--json"],
        () => {
          throw new Error("launcher must not be called");
        },
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "format-mismatch" },
      });
    });

    it("reports open-failed when the argv launcher rejects", async () => {
      const sourcePath = join(directory!, "launch-failure.epub");
      await Bun.write(sourcePath, "book contents");
      await addItem("launch-failure", sourcePath);

      const result = await invoke(
        [
          "library",
          "open",
          "--db",
          databasePath!,
          "--id",
          "launch-failure",
          "--json",
        ],
        () => {
          throw new Error("spawn failed");
        },
      );

      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "open-failed" },
      });
    });

    it("replaces editable metadata and tags durably across process invocations", async () => {
      const sourcePath = join(directory!, "editable.epub");
      await Bun.write(sourcePath, "owned contents");
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { value: { item: { id: string } } };

      const updated = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "update",
            "--id",
            imported.value.item.id,
            "--title",
            "The Dispossessed",
            "--author",
            "Ursula K. Le Guin",
            "--description",
            "An anarchist physicist crosses worlds.",
            "--tag",
            "Science Fiction",
            "--tag",
            "Classic",
          ],
          env,
        ),
      ) as {
        value: {
          item: {
            id: string;
            title: string;
            author: string;
            description: string;
            tags: string[];
            updatedAt: string;
          };
        };
      };

      expect(updated.value.item).toMatchObject({
        id: imported.value.item.id,
        title: "The Dispossessed",
        author: "Ursula K. Le Guin",
        description: "An anarchist physicist crosses worlds.",
        tags: ["Science Fiction", "Classic"],
      });
      expect(new Date(updated.value.item.updatedAt).toISOString()).toBe(
        updated.value.item.updatedAt,
      );

      const cleared = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "update",
            "--id",
            imported.value.item.id,
            "--author",
            "",
            "--description",
            "",
          ],
          env,
        ),
      ) as { value: { item: Record<string, unknown> } };
      expect(cleared.value.item.author).toBeUndefined();
      expect(cleared.value.item.description).toBeUndefined();
      expect(cleared.value.item.tags).toEqual([]);

      const reopened = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", imported.value.item.id], env),
      ) as { value: { item: Record<string, unknown> } };
      expect(reopened.value.item).toEqual(cleared.value.item);
    });

    it("passes a validated structured metadata patch through without dropping rich fields", async () => {
      const sourcePath = join(directory!, "structured.epub");
      await Bun.write(sourcePath, "owned contents");
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { value: { item: { id: string } } };
      const patch = {
        title: "A Wizard of Earthsea",
        authors: [{ name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." }],
        series: "Earthsea Cycle",
        seriesIndex: 1,
        publisher: "Parnassus Press",
        languages: ["en-US", "fr"],
        identifiers: { isbn: "9780547773742", goodreads: "13642" },
        publishedDate: "1968-11-01",
        rating: 9.5,
        description: "A young mage learns the cost of power.",
        tags: ["Fantasy", "Classic"],
      };

      const updated = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "update",
            "--id",
            imported.value.item.id,
            "--patch-json",
            JSON.stringify(patch),
          ],
          env,
        ),
      ) as { value: { item: Record<string, unknown> } };

      expect(updated.value.item).toMatchObject({
        ...patch,
        author: "Ursula K. Le Guin",
      });

      const reopened = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", imported.value.item.id], env),
      ) as { value: { item: Record<string, unknown> } };
      expect(reopened.value.item).toEqual(updated.value.item);
    });

    it("round-trips a portable OPF library and rejects oversized or changed artifacts before rebuilding", async () => {
      const epubPath = join(directory!, "portable.epub");
      const pdfPath = join(directory!, "portable.pdf");
      const coverPath = join(directory!, "portable.jpg");
      await Promise.all([
        Bun.write(epubPath, "portable epub contents"),
        Bun.write(pdfPath, "portable pdf contents"),
        Bun.write(coverPath, "portable cover contents"),
      ]);
      await addItem("portable-book", epubPath);
      const patch = {
        title: "A Portable Book",
        authors: [{ name: "Example Author", sortName: "Author, Example" }],
        series: "Portable Series",
        seriesIndex: 2,
        publisher: "Portable Press",
        languages: ["en-US"],
        identifiers: { isbn: "9780000000002" },
        customMetadata: { acquisition_source: "Book fair" },
        publishedDate: "2026-07-31",
        rating: 8.5,
        description: "Metadata that must survive reconstruction.",
        tags: ["Portable", "Verified"],
      };
      expect(parseOutput((await invoke([
        "library", "update", "--db", databasePath!, "--id", "portable-book",
        "--patch-json", JSON.stringify(patch),
      ])).output)).toMatchObject({ ok: true });
      expect(parseOutput((await invoke([
        "library", "format", "attach", "--db", databasePath!, "--id", "portable-book",
        "--source-path", pdfPath,
      ])).output)).toMatchObject({ ok: true });
      expect(parseOutput((await invoke([
        "library", "cover", "set", "--db", databasePath!, "--id", "portable-book",
        "--source-path", coverPath,
      ])).output)).toMatchObject({ ok: true });

      const portablePath = join(directory!, "portable-export");
      expect(parseOutput((await invoke([
        "library", "portable-export", "--db", databasePath!, "--dest", portablePath,
      ])).output)).toEqual({
        ok: true,
        value: { export: { path: portablePath, items: 1, formats: 2, covers: 1 } },
      });
      const rebuiltDatabase = join(directory!, "rebuilt", "library.sqlite");
      expect(parseOutput((await invoke([
        "library", "rebuild", "--db", rebuiltDatabase, "--source", portablePath,
      ])).output)).toEqual({
        ok: true,
        value: {
          rebuild: {
            path: rebuiltDatabase,
            report: {
              schemaVersion: 10,
              items: { total: 1, active: 1, trashed: 0 },
              formats: { total: 2, managed: 2, referenced: 0 },
            },
          },
        },
      });
      const rebuilt = parseOutput((await invoke([
        "library", "get", "--db", rebuiltDatabase, "--id", "portable-book",
      ])).output) as { value: { item: Record<string, unknown> & {
        formats: Array<{ format: string; sourcePath: string; provenance: string }>;
        coverPath: string;
      } } };
      expect(rebuilt.value.item).toMatchObject({ id: "portable-book", ...patch });
      expect(rebuilt.value.item.formats.map(({ format, provenance }) => ({ format, provenance }))).toEqual([
        { format: "epub", provenance: "managed" },
        { format: "pdf", provenance: "managed" },
      ]);
      expect(await Bun.file(rebuilt.value.item.formats[0]!.sourcePath).text()).toBe("portable epub contents");
      expect(await Bun.file(rebuilt.value.item.formats[1]!.sourcePath).text()).toBe("portable pdf contents");
      expect(await Bun.file(rebuilt.value.item.coverPath).text()).toBe("portable cover contents");

      const manifestPath = join(portablePath, "manifest.json");
      const manifest = await Bun.file(manifestPath).json() as {
        books: Array<{
          directory: string;
          artifacts: Array<{ path: string; bytes: number; sha256: string }>;
        }>;
      };
      const opfPath = join(portablePath, "books", manifest.books[0]!.directory, "metadata.opf");
      const opf = await Bun.file(opfPath).text();
      const oversizedOpf = opf.replace("</package>", `${" ".repeat(2 * 1024 * 1024)}</package>`);
      await Bun.write(opfPath, oversizedOpf);
      const opfArtifact = manifest.books[0]!.artifacts.find(({ path }) => path === "metadata.opf")!;
      const originalOpfArtifact = { ...opfArtifact };
      opfArtifact.bytes = Buffer.byteLength(oversizedOpf);
      opfArtifact.sha256 = createHash("sha256").update(oversizedOpf).digest("hex");
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const oversizedDatabase = join(directory!, "oversized", "library.sqlite");
      const oversized = await invoke([
        "library", "rebuild", "--db", oversizedDatabase, "--source", portablePath,
      ]);
      expect(oversized.exitCode).toBe(1);
      expect(parseOutput(oversized.output)).toEqual({ ok: false, error: { code: "source-invalid" } });
      expect(await Bun.file(oversizedDatabase).exists()).toBe(false);

      await Bun.write(opfPath, opf);
      Object.assign(opfArtifact, originalOpfArtifact);
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await Bun.write(join(portablePath, "books", manifest.books[0]!.directory, "book.pdf"), "changed");
      const rejectedDatabase = join(directory!, "rejected", "library.sqlite");
      const rejected = await invoke([
        "library", "rebuild", "--db", rejectedDatabase, "--source", portablePath,
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(parseOutput(rejected.output)).toEqual({ ok: false, error: { code: "source-invalid" } });
      expect(await Bun.file(rejectedDatabase).exists()).toBe(false);
    });

    it("rejects invalid structured patches before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "not-a-directory");
      await Bun.write(blockedDataDirectory, "opening storage through this path must fail");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };
      const oversizedPayload = JSON.stringify({
        description: "é".repeat(8_192),
        tags: [],
      });
      expect(oversizedPayload.length).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(oversizedPayload, "utf8")).toBeGreaterThan(16 * 1024);

      const invalidPayloads = [
        "{",
        "[]",
        JSON.stringify({ tags: [], sourcePath: "/tmp/forbidden.epub" }),
        JSON.stringify({ title: " " }),
        oversizedPayload,
      ];

      for (const payload of invalidPayloads) {
        expectInvalidArgumentsProcess(
          await invokeProcess(
            ["library", "update", "--id", "never-open", "--patch-json", payload],
            env,
          ),
        );
      }
    });

    it("rejects mixed structured and legacy metadata before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "not-a-directory");
      await Bun.write(blockedDataDirectory, "opening storage through this path must fail");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };
      const legacyOptions = [
        ["--title", "Mixed title"],
        ["--author", "Mixed author"],
        ["--description", "Mixed description"],
        ["--tag", "Mixed tag"],
      ];

      for (const legacyOption of legacyOptions) {
        expectInvalidArgumentsProcess(
          await invokeProcess(
            [
              "library",
              "update",
              "--id",
              "never-open",
              "--patch-json",
              JSON.stringify({ tags: [] }),
              ...legacyOption,
            ],
            env,
          ),
        );
      }
    });

    it("sets and removes an owned cover while preserving the prior cover on failure", async () => {
      const sourcePath = join(directory!, "covered.epub");
      const firstCoverPath = join(directory!, "first-cover.jpg");
      const rejectedCoverPath = join(directory!, "rejected-cover.png");
      await Promise.all([
        Bun.write(sourcePath, "book contents"),
        Bun.write(firstCoverPath, "first cover"),
        Bun.write(rejectedCoverPath, "rejected cover"),
      ]);
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", sourcePath], env),
      ) as { value: { item: { id: string } } };

      const covered = parseProcessOutput(
        await invokeProcess(
          [
            "library",
            "cover",
            "set",
            "--id",
            imported.value.item.id,
            "--source-path",
            firstCoverPath,
          ],
          env,
        ),
      ) as { value: { item: { coverPath: string } } };
      const ownedCoverPath = covered.value.item.coverPath;
      expect(ownedCoverPath).toStartWith(join(directory!, "covers"));
      expect(await Bun.file(ownedCoverPath).text()).toBe("first cover");
      expect(await Bun.file(firstCoverPath).text()).toBe("first cover");

      using database = new Database(join(directory!, "library.sqlite"));
      database.run(`
        CREATE TRIGGER reject_cover_update
        BEFORE UPDATE OF cover_path ON library_items
        BEGIN
          SELECT RAISE(ABORT, 'reject cover update');
        END
      `);

      const rejected = await invokeProcess(
        [
          "library",
          "cover",
          "set",
          "--id",
          imported.value.item.id,
          "--source-path",
          rejectedCoverPath,
        ],
        env,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toBe("");
      expect(rejected.stdout).toBe(
        JSON.stringify({ ok: false, error: { code: "storage-unavailable" } }),
      );

      const afterFailure = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", imported.value.item.id], env),
      ) as { value: { item: { coverPath: string } } };
      expect(afterFailure.value.item.coverPath).toBe(ownedCoverPath);
      expect(await Bun.file(ownedCoverPath).text()).toBe("first cover");
      expect(await Bun.file(rejectedCoverPath).text()).toBe("rejected cover");

      database.run("DROP TRIGGER reject_cover_update");
      const removed = parseProcessOutput(
        await invokeProcess(
          ["library", "cover", "remove", "--id", imported.value.item.id],
          env,
        ),
      ) as { value: { item: Record<string, unknown> } };
      expect(removed.value.item.coverPath).toBeUndefined();
      expect(await Bun.file(ownedCoverPath).exists()).toBe(false);
    });

    it("searches literal wildcard characters with stable ordering across processes", async () => {
      const items = [
        { id: "book-b", title: "100% Useful" },
        { id: "book-a", title: "100% Useful" },
        { id: "book-underscore", title: "Under_score" },
        { id: "book-slash", title: String.raw`Back\\slash` },
      ];
      for (const item of items) {
        parseProcessOutput(
          await invokeProcess([
            "library",
            "add",
            "--db",
            databasePath!,
            "--id",
            item.id,
            "--title",
            item.title,
            "--source-path",
            `${item.id}.epub`,
            "--format",
            "epub",
            "--added-at",
            "2026-07-18T12:00:00.000Z",
          ]),
        );
      }

      for (const [query, expectedIds] of [
        ["%", ["book-a", "book-b"]],
        ["_", ["book-underscore"]],
        ["\\", ["book-slash"]],
      ] as const) {
        const result = parseProcessOutput(
          await invokeProcess([
            "library",
            "search",
            "--db",
            databasePath!,
            "--query",
            query,
          ]),
        ) as { value: { items: { id: string }[] } };
        expect(result.value.items.map((item) => item.id)).toEqual(expectedIds);
      }
    });

    it("queries a deterministic catalogue page with facets across a process boundary", async () => {
      await Promise.all([
        Bun.write(join(directory!, "alpha.epub"), "alpha"),
        Bun.write(join(directory!, "beta.epub"), "beta"),
      ]);
      await addItem("alpha", join(directory!, "alpha.epub"));
      await addItem("beta", join(directory!, "beta.epub"));
      const request = {
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
        page: { offset: 0, limit: 1 },
      };

      const result = parseProcessOutput(
        await invokeProcess([
          "library",
          "query",
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify(request),
        ]),
      ) as {
        value: {
          items: { id: string }[];
          total: number;
          page: { offset: number; limit: number };
          facets: Record<string, unknown>;
        };
      };

      expect(result.value.items.map(({ id }) => id)).toEqual(["alpha"]);
      expect(result.value).toMatchObject({
        total: 2,
        page: { offset: 0, limit: 1 },
        facets: {
          authors: [],
          tags: [],
          series: [],
          languages: [],
          formats: [{ value: "epub", count: 2 }],
        },
      });
    });

    it("accepts structured requests from stdin and files without shell escaping", async () => {
      const request = JSON.stringify({
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
        page: { offset: 0, limit: 1 },
      });
      const requestPath = join(directory!, "query.json");
      await Bun.write(requestPath, request);

      for (const [source, stdin] of [[`@${requestPath}`, undefined], ["-", request]] as const) {
        const result = parseProcessOutput(
          await invokeProcess(
            [
              "library",
              "query",
              "--db",
              databasePath!,
              "--request-json",
              source,
            ],
            {},
            stdin,
          ),
        ) as { value: { items: unknown[]; total: number } };

        expect(result.value).toMatchObject({ items: [], total: 0 });
      }
    });

    it("saves, lists, and removes a catalogue view durably across processes", async () => {
      const request = {
        id: "recent-fantasy",
        name: "Recent Fantasy",
        definition: {
          version: 1,
          query: "earthsea",
          filters: {
            authors: ["Ursula K. Le Guin"],
            tags: ["Fantasy"],
            series: ["Earthsea Cycle"],
            languages: ["en-US"],
            formats: ["epub"],
          },
          sort: { field: "publishedDate", direction: "descending" },
        },
      };
      const saved = parseProcessOutput(
        await invokeProcess([
          "library",
          "saved-views",
          "save",
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify(request),
        ]),
      ) as {
        value: {
          view: typeof request & { createdAt: string; updatedAt: string };
        };
      };
      expect(saved.value.view).toMatchObject(request);
      expect(new Date(saved.value.view.createdAt).toISOString()).toBe(
        saved.value.view.createdAt,
      );
      expect(new Date(saved.value.view.updatedAt).toISOString()).toBe(
        saved.value.view.updatedAt,
      );

      const listed = parseProcessOutput(
        await invokeProcess([
          "library",
          "saved-views",
          "list",
          "--db",
          databasePath!,
        ]),
      ) as { value: { views: unknown[] } };
      expect(listed.value.views).toEqual([saved.value.view]);

      const removed = parseProcessOutput(
        await invokeProcess([
          "library",
          "saved-views",
          "remove",
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify({ id: request.id }),
        ]),
      ) as { value: { view: unknown } };
      expect(removed.value.view).toEqual(saved.value.view);

      const afterRemoval = parseProcessOutput(
        await invokeProcess([
          "library",
          "saved-views",
          "list",
          "--db",
          databasePath!,
        ]),
      ) as { value: { views: unknown[] } };
      expect(afterRemoval.value.views).toEqual([]);
    });

    it("rejects invalid catalogue JSON before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "not-a-directory");
      await Bun.write(blockedDataDirectory, "opening storage through this path must fail");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };
      const definition = {
        version: 1,
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
      };
      const query = {
        ...definition,
        page: { offset: 0, limit: 10 },
      };
      const oversizedText = "é".repeat(8_192);
      const oversizedQuery = JSON.stringify({ ...query, query: oversizedText });
      const reviewToken = "0".repeat(64);
      expect(oversizedQuery.length).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(oversizedQuery, "utf8")).toBeGreaterThan(16 * 1024);
      const invalidRequests = [
        ["library", "query", "--request-json", "{"],
        ["library", "query", "--request-json", "[]"],
        [
          "library",
          "query",
          "--request-json",
          JSON.stringify({ ...query, unexpected: true }),
        ],
        [
          "library",
          "query",
          "--request-json",
          JSON.stringify({ ...query, page: { offset: 0 } }),
        ],
        ["library", "query", "--request-json", oversizedQuery],
        [
          "library",
          "saved-views",
          "save",
          "--request-json",
          JSON.stringify({ id: "view", name: "View", definition, unexpected: true }),
        ],
        [
          "library",
          "saved-views",
          "save",
          "--request-json",
          JSON.stringify({ id: "view", name: oversizedText, definition }),
        ],
        [
          "library",
          "saved-views",
          "remove",
          "--request-json",
          JSON.stringify({ id: "view", unexpected: true }),
        ],
        [
          "library",
          "saved-views",
          "remove",
          "--request-json",
          JSON.stringify({ id: oversizedText }),
        ],
        ["library", "trash", "list", "--request-json", "{"],
        [
          "library",
          "trash",
          "list",
          "--request-json",
          JSON.stringify({ page: { offset: 0, limit: 101 } }),
        ],
        [
          "library",
          "trash",
          "move",
          "--request-json",
          JSON.stringify({ id: "item", unexpected: true }),
        ],
        [
          "library",
          "trash",
          "restore",
          "--request-json",
          JSON.stringify({ id: "" }),
        ],
        ["library", "trash", "purge", "--request-json", JSON.stringify({})],
        ["library", "duplicates", "list", "--request-json", "{"],
        [
          "library",
          "duplicates",
          "list",
          "--request-json",
          JSON.stringify({
            page: { offset: 0, limit: 10 },
            disposition: "ignored",
          }),
        ],
        [
          "library",
          "duplicates",
          "keep",
          "--request-json",
          JSON.stringify({
            leftId: "right",
            rightId: "left",
            reviewToken,
          }),
        ],
        [
          "library",
          "duplicates",
          "reopen",
          "--request-json",
          JSON.stringify({
            leftId: "left",
            rightId: "right",
            reviewToken,
            unexpected: true,
          }),
        ],
        [
          "library",
          "duplicates",
          "merge",
          "--request-json",
          JSON.stringify({
            targetId: "item",
            sourceId: "item",
            reviewToken,
            metadata: {},
            addSourceFormats: ["epub", "epub"],
            cover: "invalid",
          }),
        ],
      ];

      for (const args of invalidRequests) {
        expectInvalidArgumentsProcess(await invokeProcess(args, env));
      }
    });

    it("reports a duplicate add as JSON with a nonzero exit", async () => {
      const args = [
        "library",
        "add",
        "--db",
        databasePath!,
        "--id",
        "book-1",
        "--title",
        "The Left Hand of Darkness",
        "--source-path",
        "library/left-hand.epub",
        "--format",
        "epub",
        "--added-at",
        "2026-07-18T12:00:00.000Z",
      ];

      expect((await invoke(args)).exitCode).toBeUndefined();
      const result = await invoke(args);
      expect(result.exitCode).toBe(1);
      expect(parseOutput(result.output)).toEqual({
        ok: false,
        error: { code: "duplicate-id" },
      });
    });

    it("imports a managed copy that survives deletion of the original", async () => {
      const sourcePath = join(directory!, "original.epub");
      await Bun.write(sourcePath, "owned contents");

      const imported = await invoke([
        "library",
        "import",
        "--db",
        databasePath!,
        "--source-path",
        sourcePath,
        "--title",
        "Owned book",
      ]);
      const result = parseOutput(imported.output) as {
        ok: true;
        value: {
          item: {
            sourcePath: string;
            title: string;
            format: string;
            formats: { provenance: string }[];
          };
        };
      };

      expect(imported.exitCode).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.value.item.title).toBe("Owned book");
      expect(result.value.item.format).toBe("epub");
      expect(result.value.item.sourcePath).toStartWith(join(directory!, "items"));
      expect(result.value.item.formats[0]?.provenance).toBe("managed");

      await rm(sourcePath);

      expect(await Bun.file(result.value.item.sourcePath).text()).toBe("owned contents");
      const listed = await invoke(["library", "list", "--db", databasePath!]);
      expect(
        (parseOutput(listed.output) as { value: { items: { sourcePath: string }[] } }).value
          .items[0]?.sourcePath,
      ).toBe(result.value.item.sourcePath);
    });

    it("organizes an original into the library through the public import command", async () => {
      const sourcePath = join(directory!, "organize.epub");
      await Bun.write(sourcePath, "organized contents");

      const organized = await invoke([
        "library",
        "import",
        "--db",
        databasePath!,
        "--source-path",
        sourcePath,
        "--mode",
        "move",
      ]);

      expect(organized.exitCode).toBeUndefined();
      expect(parseOutput(organized.output)).toMatchObject({
        ok: true,
        value: {
          item: { format: "epub", formats: [{ provenance: "managed" }] },
          sourceCleanupPending: false,
        },
      });
      expect(await Bun.file(sourcePath).exists()).toBe(false);
    });

    it("rejects unsupported, missing, and non-file import sources before adding rows", async () => {
      const unsupportedPath = join(directory!, "book.xyz");
      const directoryPath = join(directory!, "folder.epub");
      await Bun.write(unsupportedPath, "unsupported");
      await mkdir(directoryPath);

      for (const sourcePath of [
        unsupportedPath,
        join(directory!, "missing.epub"),
        directoryPath,
      ]) {
        const result = await invoke([
          "library",
          "import",
          "--db",
          databasePath!,
          "--source-path",
          sourcePath,
        ]);
        expect(result.exitCode).toBe(1);
        expect(parseOutput(result.output)).toEqual({
          ok: false,
          error: { code: "invalid-arguments" },
        });
      }

      const listed = await invoke(["library", "list", "--db", databasePath!]);
      expect(parseOutput(listed.output)).toEqual({ ok: true, value: { items: [] } });
    });

    it("removes its copied file when SQLite rejects the imported row", async () => {
      const sourcePath = join(directory!, "rejected.epub");
      await Bun.write(sourcePath, "caller owned");
      expect((await invoke(["library", "list", "--db", databasePath!])).exitCode).toBeUndefined();

      using database = new Database(databasePath!);
      database.run(`
        CREATE TRIGGER reject_import
        BEFORE INSERT ON library_items
        BEGIN
          SELECT RAISE(ABORT, 'reject import');
        END
      `);

      const imported = await invoke([
        "library",
        "import",
        "--db",
        databasePath!,
        "--source-path",
        sourcePath,
      ]);

      expect(imported.exitCode).toBe(1);
      expect(parseOutput(imported.output)).toEqual({
        ok: false,
        error: { code: "storage-unavailable" },
      });
      expect(await Bun.file(sourcePath).text()).toBe("caller owned");
      expect(await readdir(join(directory!, "items"))).toEqual([]);
    });

    it("imports managed formats, attaches referenced formats, and cleans up by provenance", async () => {
      const epubPath = join(directory!, "multi.epub");
      const pdfPath = join(directory!, "multi.pdf");
      const mobiPath = join(directory!, "multi.mobi");
      await Promise.all([
        Bun.write(epubPath, "epub contents"),
        Bun.write(pdfPath, "pdf contents"),
        Bun.write(mobiPath, "mobi contents"),
      ]);

      const imported = parseOutput(
        (
          await invoke([
            "library",
            "import",
            "--db",
            databasePath!,
            "--source-path",
            epubPath,
          ])
        ).output,
      ) as { value: { item: { id: string } } };
      const id = imported.value.item.id;

      const formatImported = await invoke([
        "library",
        "format",
        "import",
        "--db",
        databasePath!,
        "--id",
        id,
        "--source-path",
        pdfPath,
      ]);
      const managedItem = parseOutput(formatImported.output) as {
        value: {
          item: {
            formats: { format: string; sourcePath: string; provenance: string }[];
          };
        };
      };
      const managedPdf = managedItem.value.item.formats.find(
        (format) => format.format === "pdf",
      )!;
      expect(formatImported.exitCode).toBeUndefined();
      expect(managedPdf.provenance).toBe("managed");
      expect(managedPdf.sourcePath).toStartWith(join(directory!, "items"));
      expect(managedPdf.sourcePath).not.toBe(pdfPath);
      expect(await Bun.file(managedPdf.sourcePath).text()).toBe("pdf contents");
      expect(await Bun.file(pdfPath).text()).toBe("pdf contents");

      const formatAttached = await invoke([
        "library",
        "format",
        "attach",
        "--db",
        databasePath!,
        "--id",
        id,
        "--source-path",
        mobiPath,
      ]);
      const referencedItem = parseOutput(formatAttached.output) as {
        value: {
          item: {
            formats: { format: string; sourcePath: string; provenance: string }[];
          };
        };
      };
      expect(formatAttached.exitCode).toBeUndefined();
      expect(
        referencedItem.value.item.formats.find((format) => format.format === "mobi"),
      ).toMatchObject({ sourcePath: await realpath(mobiPath), provenance: "referenced" });

      const managedRemoved = await invoke([
        "library",
        "format",
        "remove",
        "--db",
        databasePath!,
        "--id",
        id,
        "--format",
        "pdf",
      ]);
      expect(parseOutput(managedRemoved.output)).toMatchObject({
        ok: true,
        value: { cleanupPending: false },
      });
      expect(await Bun.file(managedPdf.sourcePath).exists()).toBe(false);
      expect(await Bun.file(pdfPath).text()).toBe("pdf contents");

      const referencedRemoved = await invoke([
        "library",
        "format",
        "remove",
        "--db",
        databasePath!,
        "--id",
        id,
        "--format",
        "mobi",
      ]);
      expect(parseOutput(referencedRemoved.output)).toMatchObject({
        ok: true,
        value: { cleanupPending: false },
      });
      expect(await Bun.file(mobiPath).text()).toBe("mobi contents");
    });

    it("atomically replaces a managed format across processes and rejects a stale snapshot", async () => {
      const originalSourcePath = join(directory!, "replace-managed-original.epub");
      const replacementSourcePath = join(directory!, "replace-managed-new.epub");
      await Promise.all([
        Bun.write(originalSourcePath, "original managed contents"),
        Bun.write(replacementSourcePath, "replacement managed contents"),
      ]);
      const env = { TAKIO_DATA_DIR: directory };
      const imported = parseProcessOutput(
        await invokeProcess(["library", "import", "--source-path", originalSourcePath], env),
      ) as {
        value: {
          item: {
            id: string;
            formats: Array<{
              sourcePath: string;
              format: string;
              addedAt: string;
              provenance: "managed" | "referenced";
            }>;
          };
        };
      };
      const originalFormat = imported.value.item.formats[0]!;
      const request = {
        id: imported.value.item.id,
        format: "epub",
        expectedCurrent: {
          sourcePath: originalFormat.sourcePath,
          addedAt: originalFormat.addedAt,
          provenance: originalFormat.provenance,
        },
        source: { kind: "copy", path: replacementSourcePath },
      };

      const replaced = parseProcessOutput(
        await invokeProcess(
          ["library", "format", "replace", "--request-json", JSON.stringify(request)],
          env,
        ),
      ) as {
        value: {
          item: {
            id: string;
            formats: Array<{
              sourcePath: string;
              format: string;
              addedAt: string;
              provenance: "managed" | "referenced";
            }>;
          };
          cleanupPending: boolean;
        };
      };
      const replacementFormat = replaced.value.item.formats.find(
        (candidate) => candidate.format === "epub",
      )!;
      expect(replaced.value.cleanupPending).toBe(false);
      expect(replacementFormat.provenance).toBe("managed");
      expect(replacementFormat.sourcePath).toStartWith(join(directory!, "items"));
      expect(replacementFormat.sourcePath).not.toBe(originalFormat.sourcePath);
      expect(await Bun.file(replacementFormat.sourcePath).text()).toBe(
        "replacement managed contents",
      );
      expect(await Bun.file(originalFormat.sourcePath).exists()).toBe(false);
      expect(await Bun.file(replacementSourcePath).text()).toBe("replacement managed contents");

      const stale = await invokeProcess(
        ["library", "format", "replace", "--request-json", JSON.stringify(request)],
        env,
      );
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toBe("");
      expect(JSON.parse(stale.stdout)).toEqual({
        ok: false,
        error: { code: "format-changed" },
      });

      const reopened = parseProcessOutput(
        await invokeProcess(["library", "get", "--id", imported.value.item.id], env),
      ) as { value: { item: unknown } };
      expect(reopened.value.item).toEqual(replaced.value.item);
      expect(await readdir(join(directory!, "items"))).toHaveLength(1);
    });

    it("atomically replaces a referenced format across processes without deleting external files", async () => {
      const originalSourcePath = join(directory!, "replace-reference-original.epub");
      const replacementSourcePath = join(directory!, "replace-reference-new.epub");
      await Promise.all([
        Bun.write(originalSourcePath, "original referenced contents"),
        Bun.write(replacementSourcePath, "replacement referenced contents"),
      ]);
      const added = parseProcessOutput(
        await invokeProcess([
          "library",
          "add",
          "--db",
          databasePath!,
          "--id",
          "replace-reference",
          "--title",
          "Replace reference",
          "--source-path",
          originalSourcePath,
          "--format",
          "epub",
          "--added-at",
          "2026-07-20T12:00:00.000Z",
        ]),
      ) as {
        value: {
          item: {
            formats: Array<{
              sourcePath: string;
              format: string;
              addedAt: string;
              provenance: "managed" | "referenced";
            }>;
          };
        };
      };
      const originalFormat = added.value.item.formats[0]!;
      const request = {
        id: "replace-reference",
        format: "epub",
        expectedCurrent: {
          sourcePath: originalFormat.sourcePath,
          addedAt: originalFormat.addedAt,
          provenance: originalFormat.provenance,
        },
        source: { kind: "reference", path: replacementSourcePath },
      };

      const replaced = parseProcessOutput(
        await invokeProcess([
          "library",
          "format",
          "replace",
          "--db",
          databasePath!,
          "--request-json",
          JSON.stringify(request),
        ]),
      ) as {
        value: {
          item: { formats: Array<{ sourcePath: string; format: string; provenance: string }> };
          cleanupPending: boolean;
        };
      };
      expect(replaced.value.cleanupPending).toBe(false);
      expect(replaced.value.item.formats.find((candidate) => candidate.format === "epub")).toEqual(
        expect.objectContaining({
          sourcePath: await realpath(replacementSourcePath),
          provenance: "referenced",
        }),
      );
      expect(await Bun.file(originalSourcePath).text()).toBe("original referenced contents");
      expect(await Bun.file(replacementSourcePath).text()).toBe("replacement referenced contents");

      const reopened = parseProcessOutput(
        await invokeProcess([
          "library",
          "get",
          "--db",
          databasePath!,
          "--id",
          "replace-reference",
        ]),
      ) as { value: { item: unknown } };
      expect(reopened.value.item).toEqual(replaced.value.item);
    });

    it("rejects invalid format replacement JSON before opening library storage", async () => {
      const blockedDataDirectory = join(directory!, "not-a-directory");
      await Bun.write(blockedDataDirectory, "opening storage through this path must fail");
      const env = { TAKIO_DATA_DIR: blockedDataDirectory };
      const validRequest = {
        id: "never-open",
        format: "epub",
        expectedCurrent: {
          sourcePath: "/tmp/original.epub",
          addedAt: "2026-07-20T12:00:00.000Z",
          provenance: "referenced",
        },
        source: { kind: "reference", path: "/tmp/replacement.epub" },
      };
      const oversizedRequest = JSON.stringify({
        ...validRequest,
        source: { kind: "reference", path: "é".repeat(8_192) },
      });
      expect(oversizedRequest.length).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(oversizedRequest, "utf8")).toBeGreaterThan(16 * 1024);

      for (const payload of [
        "{",
        "[]",
        JSON.stringify({ ...validRequest, unexpected: true }),
        JSON.stringify({ ...validRequest, expectedCurrent: { sourcePath: "/tmp/original.epub" } }),
        oversizedRequest,
      ]) {
        expectInvalidArgumentsProcess(
          await invokeProcess(
            ["library", "format", "replace", "--request-json", payload],
            env,
          ),
        );
      }
    });

    it("reports format command errors without exposing a provenance option", async () => {
      const epubPath = join(directory!, "only.epub");
      const duplicatePath = join(directory!, "duplicate.epub");
      await Promise.all([
        Bun.write(epubPath, "only contents"),
        Bun.write(duplicatePath, "duplicate contents"),
      ]);
      const imported = parseOutput(
        (
          await invoke([
            "library",
            "import",
            "--db",
            databasePath!,
            "--source-path",
            epubPath,
          ])
        ).output,
      ) as { value: { item: { id: string } } };
      const id = imported.value.item.id;

      const duplicate = await invoke([
        "library",
        "format",
        "attach",
        "--db",
        databasePath!,
        "--id",
        id,
        "--source-path",
        duplicatePath,
      ]);
      expect(duplicate.exitCode).toBe(1);
      expect(parseOutput(duplicate.output)).toEqual({
        ok: false,
        error: { code: "duplicate-format" },
      });
      expect(await Bun.file(duplicatePath).text()).toBe("duplicate contents");

      const lastFormat = await invoke([
        "library",
        "format",
        "remove",
        "--db",
        databasePath!,
        "--id",
        id,
        "--format",
        "epub",
      ]);
      expect(lastFormat.exitCode).toBe(1);
      expect(parseOutput(lastFormat.output)).toEqual({
        ok: false,
        error: { code: "last-format" },
      });

      for (const args of [
        [
          "library",
          "format",
          "remove",
          "--db",
          databasePath!,
          "--id",
          id,
          "--format",
          "unknown",
        ],
        [
          "library",
          "format",
          "attach",
          "--db",
          databasePath!,
          "--id",
          id,
          "--source-path",
          duplicatePath,
          "--provenance",
          "managed",
        ],
      ]) {
        const rejected = await invoke(args);
        expect(rejected.exitCode).toBe(1);
        expect(parseOutput(rejected.output)).toEqual({
          ok: false,
          error: { code: "invalid-arguments" },
        });
      }
    });

    it("gets and removes an imported item across separate invocations", async () => {
      const sourcePath = join(directory!, "owned.epub");
      await Bun.write(sourcePath, "owned contents");
      const imported = await invoke([
        "library",
        "import",
        "--db",
        databasePath!,
        "--source-path",
        sourcePath,
      ]);
      const item = (
        parseOutput(imported.output) as {
          value: { item: { id: string; sourcePath: string } };
        }
      ).value.item;

      const found = await invoke(["library", "get", "--db", databasePath!, "--id", item.id]);
      expect((parseOutput(found.output) as { value: { item: { id: string } } }).value.item.id).toBe(
        item.id,
      );

      const removed = await invoke([
        "library",
        "remove",
        "--db",
        databasePath!,
        "--id",
        item.id,
      ]);
      expect(parseOutput(removed.output)).toMatchObject({
        ok: true,
        value: { item: { id: item.id }, cleanupPending: false },
      });
      expect(await Bun.file(item.sourcePath).exists()).toBe(false);
      expect(await Bun.file(sourcePath).text()).toBe("owned contents");

      const missing = await invoke(["library", "get", "--db", databasePath!, "--id", item.id]);
      expect(parseOutput(missing.output)).toEqual({ ok: true, value: { item: null } });
      const removedAgain = await invoke([
        "library",
        "remove",
        "--db",
        databasePath!,
        "--id",
        item.id,
      ]);
      expect(parseOutput(removedAgain.output)).toEqual({
        ok: true,
        value: { item: null, cleanupPending: false },
      });
    });

    it("never deletes an external file referenced by low-level add", async () => {
      const sourcePath = join(directory!, "external.epub");
      await Bun.write(sourcePath, "caller owned");
      expect(
        (
          await invoke([
            "library",
            "add",
            "--db",
            databasePath!,
            "--id",
            "external-book",
            "--title",
            "External book",
            "--source-path",
            sourcePath,
            "--format",
            "epub",
            "--added-at",
            "2026-07-18T12:00:00.000Z",
          ])
        ).exitCode
      ).toBeUndefined();

      const removed = await invoke([
        "library",
        "remove",
        "--db",
        databasePath!,
        "--id",
        "external-book",
      ]);

      expect(removed.exitCode).toBeUndefined();
      expect(parseOutput(removed.output)).toMatchObject({
        ok: true,
        value: { item: { id: "external-book" }, cleanupPending: false },
      });
      expect(await Bun.file(sourcePath).text()).toBe("caller owned");
    });

    it("never deletes a referenced file inside the items directory", async () => {
      const referencedPath = join(directory!, "items", "referenced.epub");
      await mkdir(join(directory!, "items"), { recursive: true });
      await Bun.write(referencedPath, "referenced contents");
      const addedAt = "2026-07-18T12:00:00.000Z";
      await invoke([
        "library",
        "add",
        "--db",
        databasePath!,
        "--id",
        "referenced-book",
        "--title",
        "Referenced book",
        "--source-path",
        referencedPath,
        "--format",
        "epub",
        "--added-at",
        addedAt,
      ]);

      const removed = await invoke([
        "library",
        "remove",
        "--db",
        databasePath!,
        "--id",
        "referenced-book",
      ]);

      expect(removed.exitCode).toBeUndefined();
      expect(parseOutput(removed.output)).toMatchObject({
        ok: true,
        value: { item: { id: "referenced-book" }, cleanupPending: false },
      });
      expect(await Bun.file(referencedPath).text()).toBe("referenced contents");
      const missing = await invoke([
        "library",
        "get",
        "--db",
        databasePath!,
        "--id",
        "referenced-book",
      ]);
      expect(parseOutput(missing.output)).toEqual({ ok: true, value: { item: null } });
    });
  });
});
