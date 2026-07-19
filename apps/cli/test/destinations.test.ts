import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CommanderError } from "commander";

import { destinationTestSeam } from "../src/destination-test-seam.js";
import { listDestinations } from "../src/destinations.js";
import { createProgram } from "../src/main.js";

const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-destinations-"));
  temporaryRoots.add(root);
  return root;
}

async function invokeProcess(
  args: readonly string[],
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

async function invoke(
  args: readonly string[],
): Promise<{ output: string[]; exitCode?: number }> {
  const output: string[] = [];
  try {
    await createProgram(
      (line) => output.push(line),
      (line) => output.push(line),
    ).parseAsync(["bun", "takio", ...args]);
    return { output };
  } catch (error) {
    if (error instanceof CommanderError) {
      return { output, exitCode: error.exitCode };
    }
    throw error;
  }
}

function parseRecord(result: { output: string[]; exitCode?: number }): any {
  expect(result.output).toHaveLength(1);
  expect(result.output[0]).not.toContain("\n");
  expect(result.output[0]).not.toContain("\r");
  return JSON.parse(result.output[0]!);
}

async function transferFixture(): Promise<{
  root: string;
  volumesRoot: string;
  destination: string;
  databasePath: string;
  sourcePath: string;
  sourceBytes: Buffer;
}> {
  const root = await temporaryRoot();
  const volumesRoot = join(root, "Volumes");
  const destination = join(volumesRoot, "Reader");
  const sourceDirectory = join(root, "source");
  const databasePath = join(root, "library.sqlite");
  const sourcePath = join(sourceDirectory, "book.epub");
  const sourceBytes = Buffer.from("verified destination bytes\n");
  await Promise.all([
    mkdir(join(destination, ".kobo"), { recursive: true }),
    mkdir(sourceDirectory, { recursive: true }),
  ]);
  await writeFile(sourcePath, sourceBytes);

  const added = await invoke([
    "library",
    "add",
    "--db",
    databasePath,
    "--id",
    "book-1",
    "--title",
    "Transfer Book",
    "--source-path",
    relative(process.cwd(), sourcePath),
    "--format",
    "epub",
    "--added-at",
    "2026-07-18T00:00:00.000Z",
  ]);
  expect(added.exitCode).toBeUndefined();
  expect(parseRecord(added)).toMatchObject({ ok: true });

  return {
    root,
    volumesRoot,
    destination,
    databasePath,
    sourcePath,
    sourceBytes,
  };
}

afterEach(async () => {
  destinationTestSeam.afterPartialWrite = undefined;
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots.clear();
});

describe("mounted destinations", () => {
  test("classifies and sorts readable mounted directories while excluding root", async () => {
    const root = await temporaryRoot();
    await Promise.all([
      mkdir(join(root, "Kindle", "documents"), { recursive: true }),
      mkdir(join(root, "Kindle", "system"), { recursive: true }),
      mkdir(join(root, "Kobo", ".kobo"), { recursive: true }),
      mkdir(join(root, "Generic", "Books"), { recursive: true }),
      symlink("/", join(root, "System Root")),
    ]);

    const destinations = await listDestinations(root);

    expect(destinations.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "Generic", kind: "generic" },
      { id: "Kindle", kind: "kindle" },
      { id: "Kobo", kind: "kobo" },
    ]);
    expect(destinations.every((destination) => destination.freeBytes !== undefined)).toBe(
      true,
    );
    expect(destinations.every((destination) => destination.path !== "/")).toBe(true);
  });

  test("emits a successful list as one deterministic JSON line", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "Reader", "Books"), { recursive: true });

    const result = await invokeProcess([
      "destination",
      "list",
      "--volumes-root",
      root,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    const line = result.stdout.trim();
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    const parsed = JSON.parse(line) as {
      ok: boolean;
      value: { destinations: Array<Record<string, unknown>> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value.destinations).toHaveLength(1);
    const { freeBytes, ...destination } = parsed.value.destinations[0]!;
    expect(destination).toEqual({
      id: "Reader",
      name: "Reader",
      path: await realpath(join(root, "Reader")),
      kind: "generic",
    });
    expect(typeof freeBytes).toBe("number");
  });

  test("reports missing and unreadable roots without Commander prose", async () => {
    const root = await temporaryRoot();
    const nonDirectoryRoot = join(root, "not-a-directory");
    await writeFile(nonDirectoryRoot, "owned test file");
    const expected = JSON.stringify({
      ok: false,
      error: { code: "destination-unavailable" },
    });

    for (const volumesRoot of [join(root, "missing"), nonDirectoryRoot]) {
      const result = await invokeProcess([
        "destination",
        "list",
        "--volumes-root",
        volumesRoot,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
      expect(result.stdout).not.toMatch(/Usage:|Options:|Commands:/);
    }
  });

  test("isolates send parser failures as one JSON record", async () => {
    const result = await invokeProcess(["send", "--help"]);
    const expected = JSON.stringify({
      ok: false,
      error: { code: "invalid-arguments" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected);
    expect(result.stdout).not.toMatch(/Usage:|Options:|Commands:/);
  });

  test("sends and independently verifies a library source through one JSON record", async () => {
    const fixture = await transferFixture();

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBeUndefined();
    const record = parseRecord(result);
    const finalPath = join(await realpath(fixture.destination), "book.epub");
    const destinationBytes = await readFile(finalPath);
    const sha256 = createHash("sha256").update(destinationBytes).digest("hex");
    expect(destinationBytes).toEqual(fixture.sourceBytes);
    expect(record).toEqual({
      ok: true,
      value: {
        itemId: "book-1",
        destinationId: "Reader",
        path: finalPath,
        bytes: destinationBytes.byteLength,
        sha256,
      },
    });
  });

  test("rejects a collision without changing the existing destination", async () => {
    const fixture = await transferFixture();
    const finalPath = join(fixture.destination, "book.epub");
    const original = Buffer.from("existing reader copy\n");
    await writeFile(finalPath, original);

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseRecord(result)).toEqual({
      ok: false,
      error: { code: "destination-file-exists" },
    });
    expect(await readFile(finalPath)).toEqual(original);
  });

  test("overwrites only when requested and verifies the replacement", async () => {
    const fixture = await transferFixture();
    const finalPath = join(fixture.destination, "book.epub");
    await writeFile(finalPath, "old bytes");

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
      "--overwrite",
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(parseRecord(result)).toMatchObject({ ok: true });
    expect(await readFile(finalPath)).toEqual(fixture.sourceBytes);
  });

  test("rejects a destination that was not detected under the volume root", async () => {
    const fixture = await transferFixture();
    const outside = join(fixture.root, "Outside Reader");
    const unopenedDatabase = join(fixture.root, "must-not-open.sqlite");
    await mkdir(join(outside, ".kobo"), { recursive: true });

    const result = await invoke([
      "send",
      "--db",
      unopenedDatabase,
      "--id",
      "book-1",
      "--dest",
      outside,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseRecord(result)).toEqual({
      ok: false,
      error: { code: "unknown-destination" },
    });
    expect(await Bun.file(unopenedDatabase).exists()).toBe(false);
  });

  test("rejects lexical and symlink subdirectory escapes before writing", async () => {
    const fixture = await transferFixture();
    const outside = join(fixture.root, "outside-target");
    await mkdir(outside);
    await symlink(outside, join(fixture.destination, "linked"));

    for (const subdir of ["../escape", "linked"]) {
      const result = await invoke([
        "send",
        "--db",
        fixture.databasePath,
        "--id",
        "book-1",
        "--dest",
        fixture.destination,
        "--subdir",
        subdir,
        "--volumes-root",
        fixture.volumesRoot,
      ]);

      expect(result.exitCode).toBe(1);
      expect(parseRecord(result)).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
    }
    expect(await readdir(outside)).toEqual([]);
  });

  test("removes a corrupted partial and reports verification failure", async () => {
    const fixture = await transferFixture();
    destinationTestSeam.afterPartialWrite = async (partialPath) => {
      await truncate(partialPath, 3);
    };

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseRecord(result)).toEqual({
      ok: false,
      error: { code: "verification-failed" },
    });
    expect(await Bun.file(join(fixture.destination, "book.epub")).exists()).toBe(false);
    expect((await readdir(fixture.destination)).some((name) => name.startsWith(".takio-partial-"))).toBe(
      false,
    );
  });

  test("preserves a collision that appears while a copy is being verified", async () => {
    const fixture = await transferFixture();
    const finalPath = join(fixture.destination, "book.epub");
    const collision = Buffer.from("late collision\n");
    destinationTestSeam.afterPartialWrite = async () => {
      await writeFile(finalPath, collision);
    };

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseRecord(result)).toEqual({
      ok: false,
      error: { code: "destination-file-exists" },
    });
    expect(await readFile(finalPath)).toEqual(collision);
    expect((await readdir(fixture.destination)).some((name) => name.startsWith(".takio-partial-"))).toBe(
      false,
    );
  });

  test("reports missing items and source files as isolated JSON failures", async () => {
    const fixture = await transferFixture();
    const baseArgs = [
      "--db",
      fixture.databasePath,
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ];

    const unknownItem = await invoke(["send", ...baseArgs, "--id", "missing"]);
    expect(unknownItem.exitCode).toBe(1);
    expect(parseRecord(unknownItem)).toEqual({
      ok: false,
      error: { code: "unknown-item" },
    });

    await rm(fixture.sourcePath);
    const missingSource = await invoke(["send", ...baseArgs, "--id", "book-1"]);
    expect(missingSource.exitCode).toBe(1);
    expect(parseRecord(missingSource)).toEqual({
      ok: false,
      error: { code: "source-unavailable" },
    });
  });
});
