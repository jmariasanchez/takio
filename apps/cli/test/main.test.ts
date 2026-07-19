import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), ...args],
    env: { ...process.env, ...env },
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

  it("does not fabricate a plan when no local conversion capability is configured", async () => {
    const result = await invokeProcess(
      ["plan", "--input", "book.epub", "--to", "pdf"],
      { TAKIO_EBOOK_CONVERT: join(import.meta.dir, "missing-ebook-convert") },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("No online execution target can convert EPUB → PDF.\n");
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
    const job = JSON.parse(result.output[0]!) as Record<string, unknown>;
    expect(job.assignedTarget).toEqual({ id: "local", name: "This Mac" });
    expect("assignedDevice" in job).toBe(false);
  });

  it("lists only the local conversion pairs that are actually configured", async () => {
    expect(await invoke(["devices"])).toEqual({
      output: [
        "ID     STATUS  NAME      CONVERSIONS",
        "local  online  This Mac  (none)",
      ],
    });

    expect(
      await invoke(["devices"], undefined, AVAILABLE_BACKEND),
    ).toEqual({
      output: [
        "ID     STATUS  NAME      CONVERSIONS",
        "local  online  This Mac  epub→pdf",
      ],
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

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unsupported output format 'nonsense'.\n");
    expect(result.stderr).not.toContain("ZodError");
  });

  it("reports an empty --input as a stable planning error without a schema stack", async () => {
    const result = await invokeProcess(
      ["plan", "--input", "", "--to", "pdf"],
      { TAKIO_EBOOK_CONVERT: join(import.meta.dir, "missing-ebook-convert") },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid conversion request.\n");
    expect(result.stderr).not.toContain("ZodError");
  });

  for (const args of [
    ["library", "--help"],
    ["library", "add", "--help"],
    ["library", "import", "--help"],
    ["library", "get", "--help"],
    ["library", "open", "--help"],
    ["library", "update", "--help"],
    ["library", "search", "--help"],
    ["library", "cover", "--help"],
    ["library", "cover", "set", "--help"],
    ["library", "cover", "remove", "--help"],
    ["library", "remove", "--help"],
    ["library", "help", "add"],
    ["library", "help", "import"],
    ["library", "help", "get"],
    ["library", "help", "open"],
    ["library", "help", "list"],
    ["library", "help", "update"],
    ["library", "help", "search"],
    ["library", "help", "cover"],
    ["library", "help", "remove"],
  ]) {
    it(`reports ${args.join(" ")} as one JSON failure record`, async () => {
      expectInvalidArgumentsProcess(await invokeProcess(args));
    });
  }

  for (const args of [
    ["help", "library"],
    ["help", "library", "add"],
    ["help", "library", "import"],
    ["help", "library", "get"],
    ["help", "library", "open"],
    ["help", "library", "list"],
    ["help", "library", "update"],
    ["help", "library", "search"],
    ["help", "library", "format"],
    ["help", "library", "format", "import"],
    ["help", "library", "format", "attach"],
    ["help", "library", "format", "remove"],
    ["help", "library", "cover"],
    ["help", "library", "cover", "set"],
    ["help", "library", "cover", "remove"],
    ["help", "library", "remove"],
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

    it("imports, lists, and removes through the desktop process protocol", async () => {
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
      expect(human).toEqual({
        output: [`Opened open-book (epub): ${sourcePath}`],
      });
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
