import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listDestinations } from "../src/destinations.js";

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

afterEach(async () => {
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
});
