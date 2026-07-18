import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";

import { createProgram } from "../src/main.js";

async function invoke(args: string[]): Promise<{ output: string[]; exitCode?: number }> {
  const output: string[] = [];
  try {
    await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", ...args]);
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
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

describe("takio CLI", () => {
  it("lists the built-in format catalogue", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", "formats"]);

    expect(output[0]).toContain("FORMAT");
    expect(output.some((line) => line.startsWith("epub"))).toBe(true);
  });

  it("plans a conversion with the local device", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync([
      "bun",
      "takio",
      "plan",
      "--input",
      "book.epub",
      "--to",
      "pdf",
    ]);

    expect(output[0]).toStartWith("Planned job_");
    expect(output).toContain("  EPUB → PDF");
  });

  for (const args of [
    ["library", "--help"],
    ["library", "add", "--help"],
    ["library", "help", "add"],
    ["library", "help", "list"],
  ]) {
    it(`reports ${args.join(" ")} as one JSON failure record`, async () => {
      expectInvalidArgumentsProcess(await invokeProcess(args));
    });
  }

  for (const args of [
    ["help", "library"],
    ["help", "library", "add"],
    ["help", "library", "list"],
  ]) {
    it(`preserves root-owned ${args.join(" ")} help`, async () => {
      const result = await invokeProcess(args);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: takio library [command]");
      expect(result.stdout).toContain("Manage a durable local library");
      expect(result.stdout).toContain("Commands:");
      expect(result.stdout).not.toContain('"ok":false');
    });
  }

  it("reports nested library help as JSON without Commander prose", async () => {
    expectInvalidArgumentsProcess(await invokeProcess(["library", "list", "--help"]));
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

  it("preserves invalid top-level plan diagnostics", async () => {
    const result = await invokeProcess(["plan"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: required option '--input <path>' not specified");
    expect(result.stderr).not.toContain('"ok":false');
  });

  it("preserves unknown top-level command diagnostics", async () => {
    const result = await invokeProcess(["nope"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'nope'");
    expect(result.stderr).not.toContain('"ok":false');
  });

  describe("library storage", () => {
    let directory: string | undefined;
    let databasePath: string | undefined;
    let previousDataDirectory: string | undefined;

    beforeEach(async () => {
      directory = undefined;
      databasePath = undefined;
      previousDataDirectory = process.env.TAKIO_DATA_DIR;
      directory = await mkdtemp(join(tmpdir(), "takio-cli-"));
      databasePath = join(directory, "library.sqlite");
    });

    afterEach(async () => {
      if (previousDataDirectory === undefined) {
        delete process.env.TAKIO_DATA_DIR;
      } else {
        process.env.TAKIO_DATA_DIR = previousDataDirectory;
      }
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("uses the isolated production layout when --db is omitted", async () => {
      process.env.TAKIO_DATA_DIR = directory!;

      const listed = await invoke(["library", "list"]);

      expect(listed.exitCode).toBeUndefined();
      expect(parseOutput(listed.output)).toEqual({ ok: true, value: { items: [] } });
      expect(await Bun.file(join(directory!, "library.sqlite")).exists()).toBe(true);
    });

    it("adds and durably lists an item through separate invocations", async () => {
      const item = {
        id: "book-1",
        title: "The Left Hand of Darkness",
        sourcePath: "library/left-hand.epub",
        format: "epub",
        addedAt: "2026-07-18T12:00:00.000Z",
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

    it("imports an owned copy that survives deletion of the original", async () => {
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
        value: { item: { sourcePath: string; title: string; format: string } };
      };

      expect(imported.exitCode).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.value.item.title).toBe("Owned book");
      expect(result.value.item.format).toBe("epub");
      expect(result.value.item.sourcePath).toStartWith(join(directory!, "items"));

      await rm(sourcePath);

      expect(await Bun.file(result.value.item.sourcePath).text()).toBe("owned contents");
      const listed = await invoke(["library", "list", "--db", databasePath!]);
      expect(
        (parseOutput(listed.output) as { value: { items: { sourcePath: string }[] } }).value
          .items[0]?.sourcePath,
      ).toBe(result.value.item.sourcePath);
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

      expect(await Bun.file(databasePath!).exists()).toBe(false);
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
      expect((parseOutput(removed.output) as { value: { item: { id: string } } }).value.item.id).toBe(
        item.id,
      );
      expect(await Bun.file(item.sourcePath).exists()).toBe(false);

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
      expect(parseOutput(removedAgain.output)).toEqual({ ok: true, value: { item: null } });
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
      expect(await Bun.file(sourcePath).text()).toBe("caller owned");
    });

    it("reports an owned-path deletion failure after removing the row", async () => {
      const ownedDirectory = join(directory!, "items", "not-a-file.epub");
      await mkdir(ownedDirectory, { recursive: true });
      const addedAt = "2026-07-18T12:00:00.000Z";
      await invoke([
        "library",
        "add",
        "--db",
        databasePath!,
        "--id",
        "broken-owned-book",
        "--title",
        "Broken owned book",
        "--source-path",
        ownedDirectory,
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
        "broken-owned-book",
      ]);

      expect(removed.exitCode).toBe(1);
      expect(parseOutput(removed.output)).toEqual({
        ok: false,
        error: { code: "storage-unavailable" },
      });
      const missing = await invoke([
        "library",
        "get",
        "--db",
        databasePath!,
        "--id",
        "broken-owned-book",
      ]);
      expect(parseOutput(missing.output)).toEqual({ ok: true, value: { item: null } });
    });
  });
});
