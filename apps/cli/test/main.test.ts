import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

  it("reports a missing database path as JSON with a nonzero exit", async () => {
    const result = await invoke(["library", "list"]);

    expect(result.exitCode).toBe(1);
    expect(parseOutput(result.output)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
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

    beforeEach(async () => {
      directory = undefined;
      databasePath = undefined;
      directory = await mkdtemp(join(tmpdir(), "takio-cli-"));
      databasePath = join(directory, "library.sqlite");
    });

    afterEach(async () => {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
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
  });
});
