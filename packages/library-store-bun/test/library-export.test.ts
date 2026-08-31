import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { FormatId, LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";

const addedAt = "2026-07-20T00:00:00.000Z";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exportedName(title: string, id: string, extension: string): string {
  return `${title} [${sha256(id)}].${extension}`;
}

describe("BunSqliteLibraryStore export", () => {
  let directory: string;
  let databasePath: string;
  let destinationPath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-export-"));
    databasePath = join(directory, "library.sqlite");
    destinationPath = join(directory, "exports");
    await mkdir(destinationPath);
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function openStore(): Promise<BunSqliteLibraryStore> {
    const store = new BunSqliteLibraryStore(databasePath);
    stores.push(store);
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    return store;
  }

  async function addReferenced(
    store: BunSqliteLibraryStore,
    id: string,
    title: string,
    format: FormatId,
    sourcePath: string,
    metadata: Pick<LibraryItem, "author" | "authors" | "series"> = {},
  ): Promise<LibraryItem> {
    const item: LibraryItem = {
      id,
      title,
      sourcePath,
      format,
      addedAt,
      formats: [{ sourcePath, format, addedAt, provenance: "referenced" }],
      tags: [],
      ...metadata,
    };
    const result = await store.add({ item });
    if (!result.ok) {
      throw new Error(`Expected ${id} to be added`);
    }
    return result.value;
  }

  function databaseState(): unknown {
    using database = new Database(databasePath, { readonly: true, strict: true });
    return {
      items: database.query("SELECT * FROM library_items ORDER BY id").all(),
      formats: database
        .query("SELECT * FROM library_item_formats ORDER BY library_item_id, position")
        .all(),
      cleanup: database
        .query("SELECT * FROM managed_file_cleanup ORDER BY source_path, kind")
        .all(),
    };
  }

  it("exports all active formats in caller and stored order without mutation", async () => {
    const store = await openStore();
    const firstSource = join(directory, "first.mobi");
    const secondSource = join(directory, "second.epub");
    const managedSource = join(directory, "second.pdf");
    const trashedSource = join(directory, "trashed.txt");
    await writeFile(firstSource, "first referenced");
    await writeFile(secondSource, "second referenced");
    await writeFile(managedSource, "second managed");
    await writeFile(trashedSource, "trashed referenced");

    await addReferenced(store, "first-id", "First", "mobi", firstSource);
    await addReferenced(store, "second-id", "Shelf/A:* Book?", "epub", secondSource);
    const attached = await store.attachFormat({
      id: "second-id",
      source: { kind: "copy", path: managedSource },
    });
    expect(attached).toMatchObject({
      ok: true,
      value: { formats: [{ format: "epub" }, { format: "pdf", provenance: "managed" }] },
    });
    await addReferenced(store, "trashed-id", "Trashed", "txt", trashedSource);
    expect(await store.trash({ id: "trashed-id" })).toMatchObject({ ok: true });

    const stateBefore = databaseState();
    const canonicalDestination = await realpath(destinationPath);
    const firstName = exportedName("First", "first-id", "mobi");
    const epubName = exportedName("A Book", "second-id", "epub");
    const pdfName = exportedName("A Book", "second-id", "pdf");
    const result = await store.exportMany({
      ids: ["first-id", "second-id", "missing-id", "trashed-id"],
      destinationPath,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        outcomes: [
          {
            status: "exported",
            itemId: "first-id",
            format: "mobi",
            provenance: "referenced",
            destinationPath: join(canonicalDestination, firstName),
            bytes: Buffer.byteLength("first referenced"),
            sha256: sha256("first referenced"),
          },
          {
            status: "exported",
            itemId: "second-id",
            format: "epub",
            provenance: "referenced",
            destinationPath: join(canonicalDestination, epubName),
            bytes: Buffer.byteLength("second referenced"),
            sha256: sha256("second referenced"),
          },
          {
            status: "exported",
            itemId: "second-id",
            format: "pdf",
            provenance: "managed",
            destinationPath: join(canonicalDestination, pdfName),
            bytes: Buffer.byteLength("second managed"),
            sha256: sha256("second managed"),
          },
          { status: "failed", itemId: "missing-id", code: "item-not-found" },
          { status: "failed", itemId: "trashed-id", code: "item-not-found" },
        ],
        counts: { total: 5, exported: 3, skipped: 0, failed: 2 },
      },
    });
    expect(await readFile(join(destinationPath, firstName), "utf8")).toBe("first referenced");
    expect(await readFile(join(destinationPath, epubName), "utf8")).toBe("second referenced");
    expect(await readFile(join(destinationPath, pdfName), "utf8")).toBe("second managed");
    expect((await readdir(destinationPath)).sort()).toEqual([epubName, firstName, pdfName].sort());
    expect(Buffer.byteLength(basename(join(destinationPath, pdfName)))).toBeLessThanOrEqual(240);
    expect(databaseState()).toEqual(stateBefore);

    const repeated = await store.exportMany({
      ids: ["first-id", "second-id", "missing-id", "trashed-id"],
      destinationPath,
    });
    expect(repeated).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          { status: "skipped", itemId: "first-id", reason: "destination-exists" },
          { status: "skipped", itemId: "second-id", format: "epub", reason: "destination-exists" },
          { status: "skipped", itemId: "second-id", format: "pdf", reason: "destination-exists" },
          { status: "failed", itemId: "missing-id", code: "item-not-found" },
          { status: "failed", itemId: "trashed-id", code: "item-not-found" },
        ],
        counts: { total: 5, exported: 0, skipped: 3, failed: 2 },
      },
    });
    expect(databaseState()).toEqual(stateBefore);
  });

  it("keeps author-title exports flat and prefers structured primary authors", async () => {
    const store = await openStore();
    const structuredSource = join(directory, "structured.epub");
    const legacySource = join(directory, "legacy.pdf");
    const unknownSource = join(directory, "unknown.txt");
    await writeFile(structuredSource, "structured author");
    await writeFile(legacySource, "legacy author");
    await writeFile(unknownSource, "unknown author");

    await addReferenced(
      store,
      "structured-id",
      "Path/Book:* One?",
      "epub",
      structuredSource,
      {
        author: "Legacy Author",
        authors: [
          { name: "Shelf/Structured:* Author?" },
          { name: "Secondary Author" },
        ],
      },
    );
    await addReferenced(store, "legacy-id", "Legacy Book", "pdf", legacySource, {
      author: "Legacy Author",
    });
    await addReferenced(store, "unknown-id", "Unknown Book", "txt", unknownSource);

    const canonicalDestination = await realpath(destinationPath);
    const structuredName = exportedName(
      "Structured Author - Book One",
      "structured-id",
      "epub",
    );
    const legacyName = exportedName("Legacy Author - Legacy Book", "legacy-id", "pdf");
    const unknownName = exportedName("Unknown author - Unknown Book", "unknown-id", "txt");
    const result = await store.exportMany({
      ids: ["structured-id", "legacy-id", "unknown-id"],
      destinationPath,
      fileNameTemplate: "author-title",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          {
            status: "exported",
            itemId: "structured-id",
            destinationPath: join(canonicalDestination, structuredName),
          },
          {
            status: "exported",
            itemId: "legacy-id",
            destinationPath: join(canonicalDestination, legacyName),
          },
          {
            status: "exported",
            itemId: "unknown-id",
            destinationPath: join(canonicalDestination, unknownName),
          },
        ],
        counts: { total: 3, exported: 3, skipped: 0, failed: 0 },
      },
    });
    expect((await readdir(destinationPath)).sort()).toEqual(
      [structuredName, legacyName, unknownName].sort(),
    );
    expect(await readFile(join(destinationPath, structuredName), "utf8")).toBe(
      "structured author",
    );
  });

  it("organizes exports into bounded author and series directories", async () => {
    const store = await openStore();
    const source = join(directory, "organized.epub");
    await writeFile(source, "organized");
    await addReferenced(store, "organized-id", "Organized", "epub", source, {
      authors: [{ name: "Ada/Lovelace:*?" }],
      series: "Analytical/Engine:*?",
    });

    const byAuthor = await store.exportMany({
      ids: ["organized-id"],
      destinationPath,
      directoryTemplate: "author",
    });
    expect(byAuthor).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          {
            status: "exported",
            destinationPath: join(
              await realpath(destinationPath),
              "AdaLovelace",
              exportedName("Organized", "organized-id", "epub"),
            ),
          },
        ],
      },
    });

    const seriesDestination = join(directory, "series-exports");
    await mkdir(seriesDestination);
    const bySeries = await store.exportMany({
      ids: ["organized-id"],
      destinationPath: seriesDestination,
      directoryTemplate: "series",
    });
    expect(bySeries).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          {
            status: "exported",
            destinationPath: join(
              await realpath(seriesDestination),
              "AnalyticalEngine",
              exportedName("Organized", "organized-id", "epub"),
            ),
          },
        ],
      },
    });
  });

  it("continues after per-format source failures and preserves collision bytes", async () => {
    const store = await openStore();
    const missingSource = join(directory, "missing.epub");
    const emptySource = join(directory, "empty.mobi");
    const managedSource = join(directory, "managed.pdf");
    const laterSource = join(directory, "later.txt");
    await writeFile(missingSource, "remove me");
    await writeFile(emptySource, "");
    await writeFile(managedSource, "managed content");
    await writeFile(laterSource, "later content");
    await addReferenced(store, "partial-id", "Partial", "epub", missingSource);
    await addReferenced(store, "empty-id", "Empty", "mobi", emptySource);
    expect(
      await store.attachFormat({
        id: "partial-id",
        source: { kind: "copy", path: managedSource },
      }),
    ).toMatchObject({ ok: true });
    await addReferenced(store, "later-id", "Later", "txt", laterSource);
    await unlink(missingSource);

    const collisionName = exportedName("Partial", "partial-id", "pdf");
    const collisionPath = join(destinationPath, collisionName);
    await writeFile(collisionPath, "keep existing");
    const result = await store.exportMany({
      ids: ["partial-id", "empty-id", "later-id"],
      destinationPath,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcomes: [
          { status: "failed", itemId: "partial-id", format: "epub", code: "source-unavailable" },
          {
            status: "skipped",
            itemId: "partial-id",
            format: "pdf",
            reason: "destination-exists",
          },
          { status: "failed", itemId: "empty-id", format: "mobi", code: "source-unavailable" },
          { status: "exported", itemId: "later-id", format: "txt" },
        ],
        counts: { total: 4, exported: 1, skipped: 1, failed: 2 },
      },
    });
    expect(await readFile(collisionPath, "utf8")).toBe("keep existing");
    expect((await readdir(destinationPath)).every((name) => !name.endsWith(".partial"))).toBe(true);
  });

  it("rejects malformed or unusable destinations before exporting", async () => {
    const store = await openStore();
    const sourcePath = join(directory, "book.epub");
    const destinationFile = join(directory, "not-a-directory");
    await writeFile(sourcePath, "book");
    await writeFile(destinationFile, "file");
    await addReferenced(store, "book-id", "Book", "epub", sourcePath);

    for (const request of [
      { ids: [], destinationPath },
      { ids: ["book-id"], destinationPath: join(directory, "missing-directory") },
      { ids: ["book-id"], destinationPath: destinationFile },
    ]) {
      expect(await store.exportMany(request)).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
    }
    expect(await readdir(destinationPath)).toEqual([]);
  });
});
