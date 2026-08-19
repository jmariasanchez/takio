import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../src/main.ts");

async function invoke(args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_PATH, ...args],
    stdin: "ignore",
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

describe("takio library verify", () => {
  let root: string;
  let databasePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "takio-cli-integrity-"));
    databasePath = join(root, "library.sqlite");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("has actionable leaf help", async () => {
    const result = await invoke(["library", "verify", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: takio library verify [options]");
    expect(result.stdout).toContain("without changing them");
    expect(result.stdout).toContain("--db <path>");

    const backup = await invoke(["library", "backup", "--help"]);
    expect(backup.exitCode).toBe(0);
    expect(backup.stdout).toContain("--dest <directory>");
    const restore = await invoke(["library", "restore-backup", "--help"]);
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("--source <directory>");
  });

  it("fails without creating a missing library", async () => {
    const result = await invoke(["library", "verify", "--db", databasePath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });

  it("reports counts and detects managed-file tampering", async () => {
    const sourcePath = join(root, "book.epub");
    await Bun.write(sourcePath, "original ebook");
    const imported = await invoke([
      "library",
      "import",
      "--db",
      databasePath,
      "--source-path",
      sourcePath,
    ]);
    expect(imported.exitCode).toBe(0);
    const managedPath = (JSON.parse(imported.stdout) as {
      value: { item: { sourcePath: string } };
    }).value.item.sourcePath;

    const verified = await invoke(["library", "verify", "--db", databasePath]);
    expect(verified.exitCode).toBe(0);
    expect(verified.stderr).toBe("");
    expect(JSON.parse(verified.stdout)).toEqual({
      ok: true,
      value: {
        report: {
          schemaVersion: 10,
          items: { total: 1, active: 1, trashed: 0 },
          formats: { total: 1, managed: 1, referenced: 0 },
        },
      },
    });

    await Bun.write(managedPath, "tampered ebook");
    const failed = await invoke(["library", "verify", "--db", databasePath]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe("");
    expect(JSON.parse(failed.stdout)).toEqual({
      ok: false,
      error: { code: "integrity-failed" },
    });
  });

  it("backs up and restores the owned library through stable JSON envelopes", async () => {
    const sourceDatabase = join(root, "source-library", "library.sqlite");
    const sourcePath = join(root, "book.epub");
    const backupPath = join(root, "backup");
    const restoredDatabase = join(root, "restored-library", "library.sqlite");
    await Bun.write(sourcePath, "ebook for backup");
    expect(
      (
        await invoke([
          "library",
          "import",
          "--db",
          sourceDatabase,
          "--source-path",
          sourcePath,
        ])
      ).exitCode,
    ).toBe(0);

    const backup = await invoke([
      "library",
      "backup",
      "--db",
      sourceDatabase,
      "--dest",
      backupPath,
    ]);
    expect(backup.exitCode).toBe(0);
    expect(backup.stderr).toBe("");
    expect(JSON.parse(backup.stdout)).toMatchObject({
      ok: true,
      value: {
        backup: {
          path: backupPath,
          report: { schemaVersion: 10, formats: { managed: 1, referenced: 0 } },
        },
      },
    });

    const restored = await invoke([
      "library",
      "restore-backup",
      "--source",
      backupPath,
      "--db",
      restoredDatabase,
    ]);
    expect(restored.exitCode).toBe(0);
    expect(restored.stderr).toBe("");
    expect(JSON.parse(restored.stdout)).toMatchObject({
      ok: true,
      value: {
        restore: {
          path: restoredDatabase,
          report: { schemaVersion: 10, items: { total: 1 } },
        },
      },
    });
    expect(
      JSON.parse((await invoke(["library", "verify", "--db", restoredDatabase])).stdout),
    ).toMatchObject({ ok: true, value: { report: { items: { total: 1 } } } });
  });
});
