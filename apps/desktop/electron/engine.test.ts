import { describe, expect, test } from "bun:test";

import { buildEngineArguments, parseEngineRecord } from "./engine";

describe("Electron engine boundary", () => {
  test("maps only fixed command names and preserves JSON as one literal argument", async () => {
    const request = { query: "Le Guin; rm -rf /", page: { offset: 0, limit: 25 } };

    expect(await buildEngineArguments("library_query", { request })).toEqual([
      "library",
      "query",
      "--request-json",
      JSON.stringify(request),
    ]);
    expect(await buildEngineArguments("shell_exec", { command: "rm" })).toBeNull();
  });

  test("rejects blank identifiers, empty request objects, and malformed job sources", async () => {
    expect(await buildEngineArguments("library_get", { id: " " })).toBeNull();
    expect(await buildEngineArguments("library_query", { request: {} })).toBeNull();
    expect(
      await buildEngineArguments("jobs_enqueue", {
        input: "/book.epub",
        libraryItemId: "item-1",
        from: "epub",
        to: "pdf",
        output: "/book.pdf",
      }),
    ).toEqual([
      "jobs",
      "enqueue",
      "--input",
      "/book.epub",
      "--to",
      "pdf",
      "--output",
      "/book.pdf",
    ]);
  });

  test("maps explicit copy and move import modes without widening the command surface", async () => {
    expect(
      await buildEngineArguments("library_import_many", {
        sourcePaths: ["/Books/A.epub", "/Books/B.pdf"],
        mode: "move",
      }),
    ).toEqual([
      "library",
      "import-many",
      "--source-path",
      "/Books/A.epub",
      "--source-path",
      "/Books/B.pdf",
      "--mode",
      "move",
    ]);
    expect(
      await buildEngineArguments("library_import_many", {
        sourcePaths: ["/Books/A.epub"],
        mode: "link",
      }),
    ).toBeNull();
  });

  test("maps library health commands to fixed sidecar arguments", async () => {
    expect(await buildEngineArguments("library_health_location", undefined)).toEqual([
      "library",
      "path",
    ]);
    expect(await buildEngineArguments("library_health_verify", undefined)).toEqual([
      "library",
      "verify",
    ]);
    expect(await buildEngineArguments("library_health_backup", { destinationPath: "/Backups/takio" })).toEqual([
      "library",
      "backup",
      "--dest",
      "/Backups/takio",
    ]);
    expect(await buildEngineArguments("library_health_backup", { destinationPath: " " })).toBeNull();
  });

  test("accepts only protocol records consistent with the process exit code", () => {
    expect(
      parseEngineRecord(
        0,
        Buffer.from(JSON.stringify({ ok: true, value: { items: [] } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: true, value: { items: [] } });
    expect(
      parseEngineRecord(
        1,
        Buffer.from(JSON.stringify({ ok: false, error: { code: "unknown-item" } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: false, error: { code: "unknown-item" } });
    expect(
      parseEngineRecord(
        0,
        Buffer.from(JSON.stringify({ ok: false, error: { code: "unknown-item" } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
    expect(
      parseEngineRecord(0, Buffer.from("not-json"), Buffer.alloc(0)),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  });
});
