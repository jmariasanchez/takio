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
import { ejectDestination, listDestinations } from "../src/destinations.js";
import { createProgram } from "../src/main.js";
import type { EbookMetaDiscovery } from "../src/metadata.js";

const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-convert.ts");
const FAKE_METADATA_BACKEND = {
  ok: true,
  path: join(import.meta.dir, "fixtures/fake-ebook-meta.ts"),
} as const satisfies EbookMetaDiscovery;
const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-destinations-"));
  temporaryRoots.add(root);
  return root;
}

async function invokeProcess(
  args: readonly string[],
  env?: Record<string, string>,
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

async function invoke(
  args: readonly string[],
  eject?: (destinationPath: string) => Promise<number>,
  platform: NodeJS.Platform = process.platform,
  metadataBackend?: EbookMetaDiscovery,
): Promise<{ output: string[]; exitCode?: number }> {
  const output: string[] = [];
  try {
    await createProgram(
      (line) => output.push(line),
      (line) => output.push(line),
      undefined,
      eject,
      platform,
      undefined,
      metadataBackend,
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

  test("documents send arguments without reporting a JSON failure", async () => {
    const result = await invokeProcess(["send", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio send [options]");
    expect(result.stdout).toContain("--id <id>");
    expect(result.stdout).toContain("--convert");
    expect(result.stdout).toContain("--dest <volume-path>");
    expect(result.stdout).not.toContain('"ok":false');
  });

  test("ejects an authorized destination with an exact argv array", async () => {
    const root = await temporaryRoot();
    const volumesRoot = join(root, "Volumes");
    const destination = join(volumesRoot, "Reader");
    await mkdir(join(destination, ".kobo"), { recursive: true });
    const canonicalDestination = await realpath(destination);
    const argvCalls: readonly string[][] = [];

    const directExitCode = await ejectDestination(
      canonicalDestination,
      async (argv) => {
        argvCalls.push([...argv]);
        return 0;
      },
    );
    expect(directExitCode).toBe(0);
    expect(argvCalls).toEqual([
      ["diskutil", "eject", canonicalDestination],
    ]);

    const ejectCalls: string[] = [];
    const result = await invoke(
      [
        "destination",
        "eject",
        "--dest",
        destination,
        "--volumes-root",
        volumesRoot,
      ],
      async (destinationPath) => {
        ejectCalls.push(destinationPath);
        return 0;
      },
      "darwin",
    );

    expect(result.exitCode).toBeUndefined();
    expect(parseRecord(result)).toEqual({
      ok: true,
      value: { destinationId: "Reader" },
    });
    expect(ejectCalls).toEqual([canonicalDestination]);
  });

  test("isolates eject authorization, platform, and process failures", async () => {
    const root = await temporaryRoot();
    const volumesRoot = join(root, "Volumes");
    const destination = join(volumesRoot, "Reader");
    const outside = join(root, "Outside");
    await Promise.all([
      mkdir(join(destination, ".kobo"), { recursive: true }),
      mkdir(join(outside, ".kobo"), { recursive: true }),
    ]);
    const args = [
      "destination",
      "eject",
      "--dest",
      destination,
      "--volumes-root",
      volumesRoot,
    ];
    let calls = 0;
    const eject = async () => {
      calls += 1;
      return 9;
    };

    const unauthorized = await invoke(
      [
        "destination",
        "eject",
        "--dest",
        outside,
        "--volumes-root",
        volumesRoot,
      ],
      eject,
      "darwin",
    );
    expect(unauthorized.exitCode).toBe(1);
    expect(parseRecord(unauthorized)).toEqual({
      ok: false,
      error: { code: "unknown-destination" },
    });
    expect(calls).toBe(0);

    const unsupported = await invoke(args, eject, "linux");
    expect(unsupported.exitCode).toBe(1);
    expect(parseRecord(unsupported)).toEqual({
      ok: false,
      error: { code: "unsupported-platform" },
    });
    expect(calls).toBe(0);

    const failed = await invoke(args, eject, "darwin");
    expect(failed.exitCode).toBe(1);
    expect(parseRecord(failed)).toEqual({
      ok: false,
      error: { code: "eject-failed" },
    });
    expect(calls).toBe(1);
  });

  test("omits --format to send and independently verify the authoritative primary format", async () => {
    const fixture = await transferFixture();

    const result = await invoke(
      [
        "send",
        "--db",
        fixture.databasePath,
        "--id",
        "book-1",
        "--dest",
        fixture.destination,
        "--volumes-root",
        fixture.volumesRoot,
      ],
      undefined,
      process.platform,
      FAKE_METADATA_BACKEND,
    );

    expect(result.exitCode).toBeUndefined();
    const record = parseRecord(result);
    const finalPath = join(await realpath(fixture.destination), "book.epub");
    const destinationBytes = await readFile(finalPath);
    const sha256 = createHash("sha256").update(destinationBytes).digest("hex");
    expect(destinationBytes).toEqual(Buffer.from(`${fixture.sourceBytes.toString()}\nembedded metadata`));
    expect(await readFile(fixture.sourcePath)).toEqual(fixture.sourceBytes);
    expect(record).toEqual({
      ok: true,
      value: {
        itemId: "book-1",
        destinationId: "Reader",
        path: finalPath,
        bytes: destinationBytes.byteLength,
        sha256,
        format: "epub",
        converted: false,
        metadata: "embedded",
      },
    });
  });

  test("sends the exact requested secondary format with its bytes, extension, and hash", async () => {
    const fixture = await transferFixture();
    const pdfPath = join(fixture.root, "source", "book.pdf");
    const pdfBytes = Buffer.from("exact secondary PDF bytes\n");
    await writeFile(pdfPath, pdfBytes);
    const attached = await invoke([
      "library",
      "format",
      "attach",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--source-path",
      pdfPath,
    ]);
    expect(attached.exitCode).toBeUndefined();
    expect(parseRecord(attached)).toMatchObject({ ok: true });

    const result = await invoke([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--format",
      "pdf",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBeUndefined();
    const record = parseRecord(result);
    const finalPath = join(await realpath(fixture.destination), "book.pdf");
    const destinationBytes = await readFile(finalPath);
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    expect(destinationBytes).toEqual(pdfBytes);
    expect(await Bun.file(join(fixture.destination, "book.epub")).exists()).toBe(false);
    expect(record).toEqual({
      ok: true,
      value: {
        itemId: "book-1",
        destinationId: "Reader",
        path: finalPath,
        bytes: pdfBytes.byteLength,
        sha256,
        format: "pdf",
        converted: false,
        metadata: "backend-unavailable",
      },
    });
  });

  test("sends a bounded set with partial failures reported in caller order", async () => {
    const fixture = await transferFixture();
    const secondPath = join(fixture.root, "source", "second.epub");
    const secondBytes = Buffer.from("second destination bytes\n");
    await writeFile(secondPath, secondBytes);
    const added = await invoke([
      "library",
      "add",
      "--db",
      fixture.databasePath,
      "--id",
      "book-2",
      "--title",
      "Second Book",
      "--source-path",
      secondPath,
      "--format",
      "epub",
      "--added-at",
      "2026-07-31T00:00:00.000Z",
    ]);
    expect(added.exitCode).toBeUndefined();

    const result = await invoke([
      "send-many",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--id",
      "missing-book",
      "--id",
      "book-2",
      "--format",
      "epub",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ]);

    expect(result.exitCode).toBeUndefined();
    const record = parseRecord(result);
    expect(record.value.counts).toEqual({ total: 3, sent: 2, failed: 1 });
    expect(record.value.outcomes.map(({ status, itemId, code }: any) => ({ status, itemId, code }))).toEqual([
      { status: "sent", itemId: "book-1", code: undefined },
      { status: "failed", itemId: "missing-book", code: "unknown-item" },
      { status: "sent", itemId: "book-2", code: undefined },
    ]);
    expect(await readFile(join(fixture.destination, "book.epub"))).toEqual(fixture.sourceBytes);
    expect(await readFile(join(fixture.destination, "second.epub"))).toEqual(secondBytes);
  });

  test("rejects an oversized send batch before authorizing a destination", async () => {
    const root = await temporaryRoot();
    const unopenedDatabase = join(root, "must-not-open.sqlite");
    const ids = Array.from({ length: 257 }, (_, index) => ["--id", `book-${index}`]).flat();
    const result = await invoke([
      "send-many",
      "--db",
      unopenedDatabase,
      ...ids,
      "--format",
      "epub",
      "--dest",
      join(root, "missing-reader"),
      "--volumes-root",
      join(root, "Volumes"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseRecord(result)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await Bun.file(unopenedDatabase).exists()).toBe(false);
  });

  test("does not copy the primary when an explicit format is missing or unsupported", async () => {
    const fixture = await transferFixture();
    const baseArgs = [
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ];

    const missing = await invoke([...baseArgs, "--format", "pdf"]);
    expect(missing.exitCode).toBe(1);
    expect(parseRecord(missing)).toEqual({
      ok: false,
      error: { code: "format-not-found" },
    });

    const unsupported = await invoke([...baseArgs, "--format", "rtf"]);
    expect(unsupported.exitCode).toBe(1);
    expect(parseRecord(unsupported)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });

    expect(await readdir(fixture.destination)).toEqual([".kobo"]);
  });

  test("converts, verifies, attaches, and reuses a requested device format", async () => {
    const fixture = await transferFixture();
    const args = [
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--format",
      "azw3",
      "--convert",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ];

    const converted = await invokeProcess(args, { TAKIO_EBOOK_CONVERT: FAKE_BACKEND });
    expect(converted.exitCode).toBe(0);
    expect(converted.stderr).toBe("");
    const convertedRecord = JSON.parse(converted.stdout);
    const destinationPath = join(await realpath(fixture.destination), "book.azw3");
    expect(convertedRecord).toMatchObject({
      ok: true,
      value: {
        itemId: "book-1",
        destinationId: "Reader",
        path: destinationPath,
        format: "azw3",
        converted: true,
      },
    });
    expect(await readFile(destinationPath)).toEqual(fixture.sourceBytes);

    const stored = await invokeProcess([
      "library",
      "get",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
    ]);
    expect(stored.exitCode).toBe(0);
    expect(JSON.parse(stored.stdout).value.item.formats).toMatchObject([
      { format: "epub", provenance: "referenced" },
      { format: "azw3", provenance: "managed" },
    ]);

    const reused = await invokeProcess([...args, "--overwrite"], {
      TAKIO_EBOOK_CONVERT: join(fixture.root, "missing-backend"),
    });
    expect(reused.exitCode).toBe(0);
    expect(JSON.parse(reused.stdout)).toMatchObject({
      ok: true,
      value: {
        path: destinationPath,
        format: "azw3",
        converted: false,
      },
    });
  });

  test("selects and creates a Kindle-compatible format when convert-and-send omits one", async () => {
    const fixture = await transferFixture();
    await Promise.all([
      mkdir(join(fixture.destination, "documents")),
      mkdir(join(fixture.destination, "system")),
    ]);
    const baseArgs = [
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
      "--convert",
    ];

    const converted = await invokeProcess(baseArgs, { TAKIO_EBOOK_CONVERT: FAKE_BACKEND });
    expect(converted.exitCode).toBe(0);
    expect(JSON.parse(converted.stdout)).toMatchObject({
      ok: true,
      value: {
        path: join(await realpath(fixture.destination), "documents", "book.azw3"),
        format: "azw3",
        converted: true,
      },
    });

    const unsupported = await invoke([...baseArgs, "--format", "mobi"]);
    expect(unsupported.exitCode).toBe(1);
    expect(parseRecord(unsupported)).toEqual({
      ok: false,
      error: { code: "unsupported-conversion" },
    });
    expect(await readFile(join(fixture.destination, "documents", "book.azw3"))).toEqual(
      fixture.sourceBytes,
    );
  });

  test("uses Kobo's canonical compound filename for an explicit KEPUB conversion", async () => {
    const fixture = await transferFixture();
    const converted = await invokeProcess([
      "send",
      "--db",
      fixture.databasePath,
      "--id",
      "book-1",
      "--format",
      "kepub",
      "--convert",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ], { TAKIO_EBOOK_CONVERT: FAKE_BACKEND });

    expect(converted.exitCode).toBe(0);
    expect(JSON.parse(converted.stdout)).toMatchObject({
      ok: true,
      value: {
        path: join(await realpath(fixture.destination), "book.kepub.epub"),
        format: "kepub",
        converted: true,
      },
    });
  });

  test("uses the default durable library when send omits --db", async () => {
    const fixture = await transferFixture();
    const dataDirectory = join(fixture.root, "default-library");
    const env = { TAKIO_DATA_DIR: dataDirectory };
    const added = await invokeProcess([
      "library",
      "add",
      "--id",
      "book-1",
      "--title",
      "Transfer Book",
      "--source-path",
      fixture.sourcePath,
      "--format",
      "epub",
      "--added-at",
      "2026-07-18T00:00:00.000Z",
    ], env);
    expect(added.exitCode).toBe(0);

    const sent = await invokeProcess([
      "send",
      "--id",
      "book-1",
      "--dest",
      fixture.destination,
      "--volumes-root",
      fixture.volumesRoot,
    ], env);

    expect(sent.exitCode).toBe(0);
    expect(sent.stderr).toBe("");
    expect(JSON.parse(sent.stdout)).toMatchObject({
      ok: true,
      value: { itemId: "book-1", destinationId: "Reader" },
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

  test("atomically preserves a collision that appears after the initial absence check", async () => {
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
