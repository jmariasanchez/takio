import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";
import { lifecycleTestSeam } from "../src/lifecycle-test-seam.js";

const addedAt = "2026-07-19T12:00:00.000Z";

describe("BunSqliteLibraryStore managed format lifecycle", () => {
  let directory: string;
  let databasePath: string;
  let itemsDirectory: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-lifecycle-"));
    databasePath = join(directory, "library.sqlite");
    itemsDirectory = join(directory, "items");
    stores = [];
  });

  afterEach(async () => {
    delete lifecycleTestSeam.afterManagedFileInstalled;
    delete lifecycleTestSeam.beforeManagedFileCleanup;
    delete lifecycleTestSeam.duringManagedItemRemoval;
    for (const store of stores) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): BunSqliteLibraryStore {
    const store = new BunSqliteLibraryStore(databasePath);
    stores.push(store);
    return store;
  }

  async function openStore(): Promise<BunSqliteLibraryStore> {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    return store;
  }

  function referencedItem(sourcePath: string): LibraryItem {
    return {
      id: "referenced-book",
      title: "Referenced book",
      sourcePath,
      format: "epub",
      addedAt,
      formats: [{ sourcePath, format: "epub", addedAt, provenance: "referenced" }],
      tags: [],
    };
  }

  function requireItem(
    result: Awaited<ReturnType<BunSqliteLibraryStore["import"]>>,
  ): LibraryItem {
    if (!result.ok) {
      throw new Error(`Expected a library item, received ${result.error.code}`);
    }
    return result.value;
  }

  function expectedArtifact(bytes: Uint8Array): { bytes: number; sha256: string } {
    return {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  it("imports a managed copy without moving the caller's file and persists it", async () => {
    const sourcePath = join(directory, "incoming", "The Left Hand of Darkness.EPUB");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "managed epub bytes");
    const store = await openStore();

    const imported = requireItem(
      await store.import({ sourcePath, title: "The Left Hand of Darkness" }),
    );
    const managed = imported.formats[0]!;
    expect(imported).toMatchObject({
      title: "The Left Hand of Darkness",
      sourcePath: managed.sourcePath,
      format: "epub",
      formats: [{ format: "epub", provenance: "managed" }],
    });
    expect(resolve(managed.sourcePath)).not.toBe(resolve(sourcePath));
    expect(dirname(managed.sourcePath)).toBe(itemsDirectory);
    expect(extname(managed.sourcePath)).toBe(".epub");
    expect(await readFile(sourcePath)).toEqual(Buffer.from("managed epub bytes"));
    expect(await readFile(managed.sourcePath)).toEqual(Buffer.from("managed epub bytes"));
    expect(await readdir(itemsDirectory)).toEqual([basename(managed.sourcePath)]);

    store.close();
    const reopened = await openStore();
    expect(await reopened.get({ id: imported.id })).toEqual({ ok: true, value: imported });
  });

  it("keeps referenced formats inside and outside the managed root untouched", async () => {
    const primaryPath = join(directory, "primary.epub");
    const outsidePath = join(directory, "outside.mobi");
    const insidePath = join(itemsDirectory, "caller-owned.pdf");
    await mkdir(itemsDirectory, { recursive: true });
    await writeFile(primaryPath, "primary");
    await writeFile(outsidePath, "outside");
    await writeFile(insidePath, "inside");
    const canonicalPrimary = await realpath(primaryPath);
    const item = referencedItem(canonicalPrimary);
    const store = await openStore();
    expect(await store.add({ item })).toEqual({ ok: true, value: item });

    const withInside = await store.attachFormat({
      id: item.id,
      source: { kind: "reference", path: insidePath },
    });
    expect(withInside).toMatchObject({
      ok: true,
      value: { formats: [{ format: "epub" }, { format: "pdf", provenance: "referenced" }] },
    });
    const withOutside = await store.attachFormat({
      id: item.id,
      source: { kind: "reference", path: outsidePath },
    });
    expect(withOutside).toMatchObject({
      ok: true,
      value: {
        formats: [
          { format: "epub" },
          { sourcePath: await realpath(insidePath), format: "pdf", provenance: "referenced" },
          { sourcePath: await realpath(outsidePath), format: "mobi", provenance: "referenced" },
        ],
      },
    });
    expect(await readdir(itemsDirectory)).toEqual([basename(insidePath)]);

    expect(await store.remove({ id: item.id })).toMatchObject({
      ok: true,
      value: { item: { id: item.id }, cleanupPending: false },
    });
    for (const path of [primaryPath, insidePath, outsidePath]) {
      expect(await Bun.file(path).exists()).toBe(true);
    }
    store.close();
    const reopened = await openStore();
    expect(await reopened.get({ id: item.id })).toEqual({ ok: true, value: null });
    for (const path of [primaryPath, insidePath, outsidePath]) {
      expect(await Bun.file(path).exists()).toBe(true);
    }
  });

  it("copies and removes a managed secondary format without touching either source", async () => {
    const epubSource = join(directory, "incoming.epub");
    const pdfSource = join(directory, "incoming.pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, "pdf");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));

    const attached = await store.attachFormat({
      id: imported.id,
      source: { kind: "copy", path: pdfSource },
    });
    if (!attached.ok || !attached.value) {
      throw new Error("Expected a managed secondary format");
    }
    const managedPdf = attached.value.formats[1]!;
    expect(managedPdf).toMatchObject({ format: "pdf", provenance: "managed" });
    expect(dirname(managedPdf.sourcePath)).toBe(itemsDirectory);
    expect(managedPdf.sourcePath).not.toBe(pdfSource);
    expect(await readFile(pdfSource)).toEqual(Buffer.from("pdf"));
    expect(await readFile(managedPdf.sourcePath)).toEqual(Buffer.from("pdf"));

    expect(await store.removeFormat({ id: imported.id, format: "pdf" })).toMatchObject({
      ok: true,
      value: {
        item: { id: imported.id, format: "epub", formats: [{ format: "epub" }] },
        cleanupPending: false,
      },
    });
    expect(await Bun.file(managedPdf.sourcePath).exists()).toBe(false);
    expect(await Bun.file(pdfSource).exists()).toBe(true);
    expect(await Bun.file(epubSource).exists()).toBe(true);

    store.close();
    const reopened = await openStore();
    expect(await reopened.get({ id: imported.id })).toMatchObject({
      ok: true,
      value: { id: imported.id, format: "epub", formats: [{ format: "epub" }] },
    });
  });

  it("publishes a managed attachment only when its installed artifact matches", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    const pdfBytes = Buffer.from("expected-pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, pdfBytes);
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));

    const attached = await store.attachFormat({
      id: imported.id,
      source: {
        kind: "copy",
        path: pdfSource,
        expectedArtifact: expectedArtifact(pdfBytes),
      },
    });
    if (!attached.ok || !attached.value) {
      throw new Error("Expected integrity-gated managed attachment");
    }
    const managedPdf = attached.value.formats[1]!;
    expect(managedPdf).toMatchObject({ format: "pdf", provenance: "managed" });
    expect(await readFile(managedPdf.sourcePath)).toEqual(pdfBytes);
    expect(await readFile(pdfSource)).toEqual(pdfBytes);
  });

  it("rejects malformed managed artifact expectations and integrity on references", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, "pdf");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));
    const before = await readdir(itemsDirectory);

    for (const artifact of [
      { bytes: 0, sha256: "a".repeat(64) },
      { bytes: -1, sha256: "a".repeat(64) },
      { bytes: 1.5, sha256: "a".repeat(64) },
      { bytes: Number.MAX_SAFE_INTEGER + 1, sha256: "a".repeat(64) },
      { bytes: 3, sha256: "A".repeat(64) },
      { bytes: 3, sha256: "a".repeat(63) },
    ]) {
      expect(
        await store.attachFormat({
          id: imported.id,
          source: { kind: "copy", path: pdfSource, expectedArtifact: artifact },
        }),
      ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    }
    expect(
      await store.attachFormat({
        id: imported.id,
        source: {
          kind: "reference",
          path: pdfSource,
          expectedArtifact: expectedArtifact(Buffer.from("pdf")),
        },
      } as unknown as Parameters<BunSqliteLibraryStore["attachFormat"]>[0]),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(await readdir(itemsDirectory)).toEqual(before);
    expect(await store.get({ id: imported.id })).toEqual({ ok: true, value: imported });
  });

  it("rejects a same-size digest mismatch without publishing or orphaning the copy", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    const pdfBytes = Buffer.from("expected-pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, pdfBytes);
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));
    const before = await readdir(itemsDirectory);

    expect(
      await store.attachFormat({
        id: imported.id,
        source: {
          kind: "copy",
          path: pdfSource,
          expectedArtifact: expectedArtifact(Buffer.from("tampered-pdf")),
        },
      }),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(await readdir(itemsDirectory)).toEqual(before);
    expect(await store.get({ id: imported.id })).toEqual({ ok: true, value: imported });
    expect(await readFile(pdfSource)).toEqual(pdfBytes);
  });

  it("cleans an installed attachment corrupted by the lifecycle hook before publication", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    const pdfBytes = Buffer.from("expected-pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, pdfBytes);
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));
    const before = await readdir(itemsDirectory);
    lifecycleTestSeam.afterManagedFileInstalled = (path) => {
      writeFileSync(path, "tampered-pdf");
    };

    expect(
      await store.attachFormat({
        id: imported.id,
        source: {
          kind: "copy",
          path: pdfSource,
          expectedArtifact: expectedArtifact(pdfBytes),
        },
      }),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(await readdir(itemsDirectory)).toEqual(before);
    expect(await store.get({ id: imported.id })).toEqual({ ok: true, value: imported });
    expect(await readFile(pdfSource)).toEqual(pdfBytes);
  });

  it("publishes the verified installed copy when the caller mutates its source afterward", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    const pdfBytes = Buffer.from("expected-pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, pdfBytes);
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));
    lifecycleTestSeam.afterManagedFileInstalled = () => {
      writeFileSync(pdfSource, "caller-changed");
    };

    const attached = await store.attachFormat({
      id: imported.id,
      source: {
        kind: "copy",
        path: pdfSource,
        expectedArtifact: expectedArtifact(pdfBytes),
      },
    });
    if (!attached.ok || !attached.value) {
      throw new Error("Expected the verified installed copy to be published");
    }
    expect(await readFile(attached.value.formats[1]!.sourcePath)).toEqual(pdfBytes);
    expect(await readFile(pdfSource)).toEqual(Buffer.from("caller-changed"));
  });

  it("rejects duplicates and last-format removal without changing files", async () => {
    const sourcePath = join(directory, "book.epub");
    const duplicatePath = join(directory, "duplicate.epub");
    await writeFile(sourcePath, "book");
    await writeFile(duplicatePath, "duplicate");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath }));
    const before = await readdir(itemsDirectory);

    expect(
      await store.attachFormat({
        id: imported.id,
        source: { kind: "copy", path: duplicatePath },
      }),
    ).toEqual({ ok: false, error: { code: "duplicate-format" } });
    expect(await readdir(itemsDirectory)).toEqual(before);
    expect(await store.removeFormat({ id: imported.id, format: "pdf" })).toEqual({
      ok: true,
      value: { item: imported, cleanupPending: false },
    });
    expect(await store.removeFormat({ id: imported.id, format: "epub" })).toEqual({
      ok: false,
      error: { code: "last-format" },
    });
    expect(await store.get({ id: imported.id })).toEqual({ ok: true, value: imported });
    expect(await Bun.file(imported.sourcePath).exists()).toBe(true);

    expect(
      await store.attachFormat({
        id: "missing",
        source: { kind: "reference", path: duplicatePath },
      }),
    ).toEqual({ ok: true, value: null });
    expect(await store.removeFormat({ id: "missing", format: "epub" })).toEqual({
      ok: true,
      value: { item: null, cleanupPending: false },
    });
  });

  it("rolls back a managed import when installation fails before the database write", async () => {
    const sourcePath = join(directory, "book.epub");
    await writeFile(sourcePath, "book");
    const store = await openStore();
    lifecycleTestSeam.afterManagedFileInstalled = () => {
      throw new Error("injected install failure");
    };

    expect(await store.import({ sourcePath })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await store.list({})).toEqual({ ok: true, value: [] });
    expect(await Bun.file(sourcePath).exists()).toBe(true);
    expect(await readdir(itemsDirectory)).toEqual([]);
  });

  it("reports deferred cleanup and retries it when the store reopens", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    const referencedSource = join(directory, "book.mobi");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, "pdf");
    await writeFile(referencedSource, "mobi");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath: epubSource }));
    const withPdf = await store.attachFormat({
      id: imported.id,
      source: { kind: "copy", path: pdfSource },
    });
    if (!withPdf.ok || !withPdf.value) {
      throw new Error("Expected copied PDF");
    }
    const managedPaths = withPdf.value.formats.map(({ sourcePath }) => sourcePath);
    expect(
      await store.attachFormat({
        id: imported.id,
        source: { kind: "reference", path: referencedSource },
      }),
    ).toMatchObject({ ok: true, value: { formats: [{}, {}, { provenance: "referenced" }] } });
    const attempted: string[] = [];
    lifecycleTestSeam.beforeManagedFileCleanup = (path) => {
      attempted.push(path);
      throw new Error("injected cleanup failure");
    };

    expect(await store.remove({ id: imported.id })).toMatchObject({
      ok: true,
      value: { item: { id: imported.id }, cleanupPending: true },
    });
    expect(attempted.length).toBeGreaterThan(0);
    expect(await store.get({ id: imported.id })).toEqual({ ok: true, value: null });
    expect(await Bun.file(referencedSource).exists()).toBe(true);
    expect(await Promise.all(managedPaths.map((path) => Bun.file(path).exists()))).toContain(true);

    store.close();
    delete lifecycleTestSeam.beforeManagedFileCleanup;
    await openStore();
    expect(await Promise.all(managedPaths.map((path) => Bun.file(path).exists()))).toEqual([
      false,
      false,
    ]);
    expect(await Bun.file(referencedSource).exists()).toBe(true);
  });

  it("keeps a pending managed file that another item adopts as referenced", async () => {
    const pdfSource = join(directory, "removed-book.pdf");
    const epubSource = join(directory, "surviving-book.epub");
    await writeFile(pdfSource, "pdf");
    await writeFile(epubSource, "epub");
    const store = await openStore();
    const removedItem = requireItem(await store.import({ sourcePath: pdfSource }));
    const pendingPath = removedItem.sourcePath;
    const canonicalPendingPath = await realpath(pendingPath);
    const survivingItem = referencedItem(await realpath(epubSource));
    expect(await store.add({ item: survivingItem })).toEqual({
      ok: true,
      value: survivingItem,
    });
    lifecycleTestSeam.beforeManagedFileCleanup = (path) => {
      if (path === pendingPath) {
        throw new Error("injected cleanup failure");
      }
    };

    expect(await store.remove({ id: removedItem.id })).toMatchObject({
      ok: true,
      value: { item: { id: removedItem.id }, cleanupPending: true },
    });
    expect(await Bun.file(pendingPath).exists()).toBe(true);
    delete lifecycleTestSeam.beforeManagedFileCleanup;
    expect(
      await store.attachFormat({
        id: survivingItem.id,
        source: { kind: "reference", path: pendingPath },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        id: survivingItem.id,
        formats: [
          { format: "epub", provenance: "referenced" },
          { sourcePath: canonicalPendingPath, format: "pdf", provenance: "referenced" },
        ],
      },
    });

    store.close();
    const reopened = await openStore();
    expect(await reopened.get({ id: survivingItem.id })).toMatchObject({
      ok: true,
      value: {
        formats: [
          { format: "epub", provenance: "referenced" },
          { sourcePath: canonicalPendingPath, format: "pdf", provenance: "referenced" },
        ],
      },
    });
    expect(await readFile(pendingPath)).toEqual(Buffer.from("pdf"));
  });

  it("reports owned-cover cleanup as pending and retries it when the store reopens", async () => {
    const bookSource = join(directory, "book.epub");
    const coverSource = join(directory, "cover.png");
    await writeFile(bookSource, "book");
    await writeFile(coverSource, "cover");
    const store = await openStore();
    const item = referencedItem(await realpath(bookSource));
    expect(await store.add({ item })).toEqual({ ok: true, value: item });
    const withCover = await store.setCover({ id: item.id, sourcePath: coverSource });
    if (!withCover.ok || !withCover.value?.coverPath) {
      throw new Error("Expected an owned cover");
    }
    const ownedCoverPath = withCover.value.coverPath;
    lifecycleTestSeam.beforeManagedFileCleanup = (path) => {
      if (path === ownedCoverPath) {
        throw new Error("injected cover cleanup failure");
      }
    };

    expect(await store.remove({ id: item.id })).toMatchObject({
      ok: true,
      value: { item: { id: item.id }, cleanupPending: true },
    });
    expect(await store.get({ id: item.id })).toEqual({ ok: true, value: null });
    expect(await Bun.file(ownedCoverPath).exists()).toBe(true);
    expect(await Bun.file(coverSource).exists()).toBe(true);

    store.close();
    delete lifecycleTestSeam.beforeManagedFileCleanup;
    await openStore();
    expect(await Bun.file(ownedCoverPath).exists()).toBe(false);
    expect(await Bun.file(coverSource).exists()).toBe(true);
  });

  it("does not orphan a managed file when attach races whole-item removal", async () => {
    const epubSource = join(directory, "book.epub");
    const pdfSource = join(directory, "book.pdf");
    await writeFile(epubSource, "epub");
    await writeFile(pdfSource, "pdf");
    const removingStore = await openStore();
    const attachingStore = await openStore();
    const imported = requireItem(await removingStore.import({ sourcePath: epubSource }));
    let attachment: ReturnType<BunSqliteLibraryStore["attachFormat"]> | undefined;
    lifecycleTestSeam.duringManagedItemRemoval = () => {
      attachment = attachingStore.attachFormat({
        id: imported.id,
        source: { kind: "copy", path: pdfSource },
      });
    };

    expect(await removingStore.remove({ id: imported.id })).toMatchObject({
      ok: true,
      value: { item: { id: imported.id }, cleanupPending: false },
    });
    if (!attachment) {
      throw new Error("Expected removal to exercise the concurrent-attach seam");
    }
    expect(await attachment).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await readdir(itemsDirectory)).toEqual([]);
    expect(await Bun.file(epubSource).exists()).toBe(true);
    expect(await Bun.file(pdfSource).exists()).toBe(true);
  });

  it("refuses traversal-tampered managed paths without deleting an external file", async () => {
    const sourcePath = join(directory, "book.epub");
    const outsidePath = join(directory, "outside.epub");
    await writeFile(sourcePath, "book");
    await writeFile(outsidePath, "outside");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath }));

    using database = new Database(databasePath, { strict: true });
    database.run(
      `UPDATE library_item_formats SET source_path = ?
        WHERE library_item_id = ? AND format = 'epub'`,
      [`../${basename(outsidePath)}`, imported.id],
    );
    expect(await store.remove({ id: imported.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await Bun.file(outsidePath).exists()).toBe(true);
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM library_items WHERE id = ?",
        )
        .get(imported.id),
    ).toEqual({ count: 1 });
  });

  it("refuses a symlink-tampered managed path without following it", async () => {
    const sourcePath = join(directory, "book.epub");
    const outsidePath = join(directory, "outside.epub");
    await writeFile(sourcePath, "book");
    await writeFile(outsidePath, "outside");
    const store = await openStore();
    const imported = requireItem(await store.import({ sourcePath }));
    await rm(imported.sourcePath);
    await symlink(outsidePath, imported.sourcePath);

    expect(await store.remove({ id: imported.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await Bun.file(outsidePath).exists()).toBe(true);
    using database = new Database(databasePath, { strict: true });
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM library_items WHERE id = ?",
        )
        .get(imported.id),
    ).toEqual({ count: 1 });
  });
});
