import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";

import { createProgram } from "../src/main.js";

let directory: string;
let databasePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "takio-cli-"));
  databasePath = join(directory, "library.sqlite");
});

afterEach(async () => {
  await rm(directory, { recursive: true });
});

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

function parseOutput(output: string[]): unknown {
  expect(output).toHaveLength(1);
  const line = output[0]!;
  expect(line).not.toContain("\n");
  expect(line).not.toContain("\r");
  return JSON.parse(line);
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
      databasePath,
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

    const listed = await invoke(["library", "list", "--db", databasePath]);
    expect(listed.exitCode).toBeUndefined();
    expect(parseOutput(listed.output)).toEqual({ ok: true, value: { items: [item] } });
  });

  it("reports a missing database path as JSON with a nonzero exit", async () => {
    const result = await invoke(["library", "list"]);

    expect(result.exitCode).toBe(1);
    expect(parseOutput(result.output)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
  });

  it("reports a duplicate add as JSON with a nonzero exit", async () => {
    const args = [
      "library",
      "add",
      "--db",
      databasePath,
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
