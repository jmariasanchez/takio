import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BunSqliteLibraryStore,
  createLibraryBackup,
  restoreLibraryBackup,
  verifyLibraryIntegrity,
} from "../src/index.js";

describe("library integrity verification", () => {
  let root: string;
  let databasePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "takio-library-integrity-"));
    databasePath = join(root, "library.sqlite");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not create or migrate a missing library", async () => {
    expect(verifyLibraryIntegrity(databasePath)).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });

  it("reports schema, item, and ownership counts after all checks pass", async () => {
    const sourcePath = join(root, "book.epub");
    await Bun.write(sourcePath, "managed ebook");
    const store = new BunSqliteLibraryStore(databasePath);
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect((await store.import({ sourcePath })).ok).toBe(true);
    store.close();

    expect(verifyLibraryIntegrity(databasePath)).toEqual({
      ok: true,
      value: {
        schemaVersion: 8,
        items: { total: 1, active: 1, trashed: 0 },
        formats: { total: 1, managed: 1, referenced: 0 },
      },
    });
  });

  it("detects a changed managed file from its stored SHA-256 fingerprint", async () => {
    const sourcePath = join(root, "book.epub");
    await Bun.write(sourcePath, "original ebook");
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });
    const imported = await store.import({ sourcePath });
    if (!imported.ok) throw new Error("Expected managed import");
    store.close();

    await Bun.write(imported.value.sourcePath, "tampered ebook");

    expect(verifyLibraryIntegrity(databasePath)).toEqual({
      ok: false,
      error: { code: "integrity-failed" },
    });
  });

  it("rejects an unsupported schema without changing its version", () => {
    using database = new Database(databasePath, { create: true, strict: true });
    database.run("PRAGMA user_version = 99");

    expect(verifyLibraryIntegrity(databasePath)).toEqual({
      ok: false,
      error: { code: "incompatible-schema" },
    });
    expect(
      database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(99);
  });

  it("backs up owned files and restores them into a new library root", async () => {
    const sourceRoot = join(root, "source-library");
    await mkdir(sourceRoot);
    databasePath = join(sourceRoot, "library.sqlite");
    const epubPath = join(root, "book.epub");
    const pdfPath = join(root, "book.pdf");
    const coverPath = join(root, "cover.jpg");
    await Promise.all([
      Bun.write(epubPath, "managed epub"),
      Bun.write(pdfPath, "caller-owned pdf"),
      Bun.write(coverPath, "managed cover"),
    ]);
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });
    const imported = await store.import({ sourcePath: epubPath });
    if (!imported.ok) throw new Error("Expected managed import");
    expect(
      await store.attachFormat({
        id: imported.value.id,
        source: { kind: "reference", path: pdfPath },
      }),
    ).toMatchObject({ ok: true });
    expect(await store.setCover({ id: imported.value.id, sourcePath: coverPath })).toMatchObject({
      ok: true,
    });
    store.close();

    const backupPath = join(root, "backup");
    expect(createLibraryBackup(databasePath, backupPath)).toEqual({
      ok: true,
      value: {
        path: backupPath,
        report: {
          schemaVersion: 8,
          items: { total: 1, active: 1, trashed: 0 },
          formats: { total: 2, managed: 1, referenced: 1 },
        },
      },
    });
    expect(await Bun.file(join(backupPath, "manifest.json")).exists()).toBe(true);

    await Bun.write(imported.value.sourcePath, "changed after backup");
    await Bun.write(coverPath, "changed caller cover");
    const restoredDatabasePath = join(root, "restored-library", "catalog.sqlite");
    expect(restoreLibraryBackup(backupPath, restoredDatabasePath)).toEqual({
      ok: true,
      value: {
        path: restoredDatabasePath,
        report: {
          schemaVersion: 8,
          items: { total: 1, active: 1, trashed: 0 },
          formats: { total: 2, managed: 1, referenced: 1 },
        },
      },
    });

    const restored = new BunSqliteLibraryStore(restoredDatabasePath);
    expect(await restored.open({ config: {} })).toEqual({ ok: true, value: null });
    const item = await restored.get({ id: imported.value.id });
    if (!item.ok || !item.value) throw new Error("Expected restored item");
    expect(await Bun.file(item.value.sourcePath).text()).toBe("managed epub");
    expect(await Bun.file(item.value.coverPath!).text()).toBe("managed cover");
    expect(item.value.formats.find(({ format }) => format === "pdf")?.sourcePath).toBe(
      await realpath(pdfPath),
    );
    restored.close();

    const [backedUpCoverName] = await readdir(join(backupPath, "covers"));
    await Bun.write(join(backupPath, "covers", backedUpCoverName!), "tampered cover");
    expect(
      restoreLibraryBackup(backupPath, join(root, "second-restore", "library.sqlite")),
    ).toEqual({ ok: false, error: { code: "invalid-backup" } });
  });

  it("never overwrites a backup or an existing restore destination", async () => {
    const sourceRoot = join(root, "source-library");
    await mkdir(sourceRoot);
    databasePath = join(sourceRoot, "library.sqlite");
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });
    store.close();

    const backupPath = join(root, "backup");
    expect(createLibraryBackup(databasePath, backupPath).ok).toBe(true);
    expect(createLibraryBackup(databasePath, backupPath)).toEqual({
      ok: false,
      error: { code: "destination-exists" },
    });

    const existingRoot = join(root, "existing-library");
    await mkdir(existingRoot);
    const markerPath = join(existingRoot, "keep.txt");
    await Bun.write(markerPath, "keep me");
    expect(restoreLibraryBackup(backupPath, join(existingRoot, "library.sqlite"))).toEqual({
      ok: false,
      error: { code: "destination-exists" },
    });
    expect(await Bun.file(markerPath).text()).toBe("keep me");
  });

  it("rejects a backup whose managed file no longer matches the database", async () => {
    const sourceRoot = join(root, "source-library");
    await mkdir(sourceRoot);
    databasePath = join(sourceRoot, "library.sqlite");
    const sourcePath = join(root, "book.epub");
    await Bun.write(sourcePath, "managed ebook");
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });
    await store.import({ sourcePath });
    store.close();

    const backupPath = join(root, "backup");
    expect(createLibraryBackup(databasePath, backupPath).ok).toBe(true);
    const [managedName] = await readdir(join(backupPath, "items"));
    await Bun.write(join(backupPath, "items", managedName!), "tampered backup");

    expect(
      restoreLibraryBackup(backupPath, join(root, "restored-library", "library.sqlite")),
    ).toEqual({ ok: false, error: { code: "invalid-backup" } });
  });
});
