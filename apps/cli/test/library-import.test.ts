import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { LibraryItem } from "@takio/core";
import type {
  LibraryImportEntryOutcome,
  LibraryMetadataPatch,
} from "@takio/library-contract";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  importCalibreLibrary,
  enrichImportedLibraryOutcomes,
  type MetadataImportStore,
} from "../src/library-import.js";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";

const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-meta.ts");
const ADDED_AT = "2026-07-20T12:00:00.000Z";
const roots: string[] = [];
let priorBackend: string | undefined;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-library-import-metadata-test-"));
  roots.push(root);
  return root;
}

async function managedItem(
  root: string,
  id: string,
  control: Record<string, unknown>,
  provenance: "managed" | "referenced" = "managed",
): Promise<LibraryItem> {
  const sourcePath = join(root, `${id}.epub`);
  await writeFile(sourcePath, JSON.stringify({ fakeEbookMeta: control }));
  return {
    id,
    title: id,
    sourcePath,
    format: "epub",
    addedAt: ADDED_AT,
    formats: [{ sourcePath, format: "epub", addedAt: ADDED_AT, provenance }],
    tags: [],
  };
}

function imported(item: LibraryItem): LibraryImportEntryOutcome {
  return { status: "imported", sourcePath: `/original/${item.id}.epub`, item };
}

function updatedItem(item: LibraryItem, patch: LibraryMetadataPatch): LibraryItem {
  return {
    ...item,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.authors === undefined || patch.authors === null
      ? {}
      : { authors: patch.authors }),
    tags: patch.tags,
    updatedAt: "2026-07-20T12:01:00.000Z",
  };
}

beforeEach(() => {
  priorBackend = process.env.TAKIO_EBOOK_META;
  process.env.TAKIO_EBOOK_META = FAKE_BACKEND;
});

afterEach(async () => {
  if (priorBackend === undefined) {
    delete process.env.TAKIO_EBOOK_META;
  } else {
    process.env.TAKIO_EBOOK_META = priorBackend;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("library import metadata enrichment", () => {
  it("enriches managed imports sequentially, installs verified covers, and preserves other outcomes", async () => {
    const root = await temporaryRoot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const first = await managedItem(root, "first", {
      opf: `<package><metadata><dc:title>First extracted</dc:title>
        <dc:creator opf:role="aut">First Author</dc:creator></metadata></package>`,
      coverBase64: png.toString("base64"),
    });
    const second = await managedItem(root, "second", {
      opf: "<package><metadata><dc:title>Second extracted</dc:title></metadata></package>",
    });
    const referenced = await managedItem(root, "referenced", {}, "referenced");
    const skipped: LibraryImportEntryOutcome = {
      status: "skipped",
      sourcePath: join(root, "notes.txt"),
      reason: "unsupported-format",
    };
    const outcomes = [imported(first), skipped, imported(referenced), imported(second)] as const;
    const calls: string[] = [];
    let temporaryCoverPath: string | undefined;

    const store: MetadataImportStore = {
      update: async ({ id, patch }) => {
        calls.push(`update:${id}:${patch.title}`);
        const original = id === first.id ? first : second;
        return { ok: true, value: updatedItem(original, patch) };
      },
      setCover: async ({ id, sourcePath }) => {
        calls.push(`cover:${id}`);
        temporaryCoverPath = sourcePath;
        expect(await readFile(sourcePath)).toEqual(png);
        const base = updatedItem(first, {
          title: "First extracted",
          authors: [{ name: "First Author" }],
          tags: [],
        });
        return { ok: true, value: { ...base, coverPath: `/covers/${id}.png` } };
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, outcomes);

    expect(calls).toEqual([
      "update:first:First extracted",
      "cover:first",
      "update:second:Second extracted",
    ]);
    expect(result[0]).toMatchObject({
      status: "imported",
      sourcePath: "/original/first.epub",
      item: {
        title: "First extracted",
        authors: [{ name: "First Author" }],
        coverPath: "/covers/first.png",
      },
    });
    expect(result[1]).toBe(skipped);
    expect(result[2]).toBe(outcomes[2]);
    expect(result[3]).toMatchObject({ item: { title: "Second extracted" } });
    expect(temporaryCoverPath).toBeDefined();
    expect(stat(temporaryCoverPath!)).rejects.toThrow();
  });

  it("lets a single-import title override win over extracted metadata", async () => {
    const root = await temporaryRoot();
    const item = await managedItem(root, "title", {
      opf: "<package><metadata><dc:title>Extracted title</dc:title></metadata></package>",
    });
    let receivedPatch: LibraryMetadataPatch | undefined;
    const store: MetadataImportStore = {
      update: async ({ patch }) => {
        receivedPatch = patch;
        return { ok: true, value: updatedItem(item, patch) };
      },
      setCover: async () => {
        throw new Error("No cover expected");
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, [imported(item)], {
      titleOverride: "Explicit title",
    });

    expect(receivedPatch).toEqual({ title: "Explicit title", tags: [] });
    expect(result[0]).toMatchObject({ item: { title: "Explicit title" } });
  });

  it("preserves imports across discovery, extraction, metadata update, and cover failures", async () => {
    const root = await temporaryRoot();
    const extractionFailure = await managedItem(root, "extract-failure", { mode: "nonzero" });
    const updateFailure = await managedItem(root, "update-failure", {
      opf: "<package><metadata><dc:title>Update attempted</dc:title></metadata></package>",
    });
    const coverFailure = await managedItem(root, "cover-failure", {
      opf: "<package><metadata><dc:title>Metadata survives</dc:title></metadata></package>",
      coverBase64: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString("base64"),
    });
    const extractionOutcome = imported(extractionFailure);
    const updateOutcome = imported(updateFailure);
    const coverOutcome = imported(coverFailure);
    const calls: string[] = [];
    const store: MetadataImportStore = {
      update: async ({ id, patch }) => {
        calls.push(`update:${id}`);
        if (id === updateFailure.id) {
          return { ok: false, error: { code: "storage-unavailable" } };
        }
        return { ok: true, value: updatedItem(coverFailure, patch) };
      },
      setCover: async ({ id }) => {
        calls.push(`cover:${id}`);
        return { ok: false, error: { code: "storage-unavailable" } };
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, [
      extractionOutcome,
      updateOutcome,
      coverOutcome,
    ]);

    expect(calls).toEqual(["update:update-failure", "update:cover-failure", "cover:cover-failure"]);
    expect(result[0]).toBe(extractionOutcome);
    expect(result[1]).toBe(updateOutcome);
    expect(result[2]).toMatchObject({
      status: "imported",
      item: { id: "cover-failure", title: "Metadata survives" },
    });

    process.env.TAKIO_EBOOK_META = join(root, "missing-ebook-meta");
    const undiscovered = await enrichImportedLibraryOutcomes(store, [coverOutcome]);
    expect(undiscovered[0]).toBe(coverOutcome);
    expect(calls).toHaveLength(3);
  });
});

describe("Calibre library import", () => {
  it("imports Calibre metadata, multiple formats, cover, and custom columns without writing to metadata.db", async () => {
    const root = await temporaryRoot();
    const dbPath = join(root, "metadata.db");
    using calibre = new Database(dbPath, { create: true, strict: true });
    calibre.exec(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, path TEXT NOT NULL, series_index REAL, pubdate TEXT);
      CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, sort TEXT);
      CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
      CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
      CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
      CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT);
      CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER, lang_code INTEGER, item_order INTEGER);
      CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
      CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
      CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER);
      CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER, rating INTEGER);
      CREATE TABLE custom_columns (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
      CREATE TABLE custom_column_1 (id INTEGER PRIMARY KEY, book INTEGER, value TEXT);
      INSERT INTO books VALUES (1, 'Calibre Title', 'Author/Calibre Title (1)', 2.5, '2020-05-02 00:00:00+00:00');
      INSERT INTO authors VALUES (1, 'Ada Lovelace', 'Lovelace, Ada');
      INSERT INTO books_authors_link VALUES (1, 1, 1);
      INSERT INTO series VALUES (1, 'Analytical Engines');
      INSERT INTO books_series_link VALUES (1, 1, 1);
      INSERT INTO publishers VALUES (1, 'First Publisher');
      INSERT INTO books_publishers_link VALUES (1, 1, 1);
      INSERT INTO tags VALUES (1, 'Math'), (2, 'Computing');
      INSERT INTO books_tags_link VALUES (1, 1, 1), (2, 1, 2);
      INSERT INTO languages VALUES (1, 'en');
      INSERT INTO books_languages_link VALUES (1, 1, 1, 0);
      INSERT INTO identifiers VALUES (1, 1, 'isbn', '9780000000001');
      INSERT INTO comments VALUES (1, 1, 'Important description');
      INSERT INTO data VALUES (1, 1, 'EPUB', 'Calibre Title - Ada'), (2, 1, 'PDF', 'Calibre Title - Ada');
      INSERT INTO ratings VALUES (1, 4);
      INSERT INTO books_ratings_link VALUES (1, 1, 1);
      INSERT INTO custom_columns VALUES (1, 'custom_column_1', 'reading_state');
      INSERT INTO custom_column_1 VALUES (1, 1, 'planned');
    `);
    calibre.close();
    const bookDir = join(root, "Author/Calibre Title (1)");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bookDir, { recursive: true }));
    await writeFile(join(bookDir, "Calibre Title - Ada.epub"), "epub bytes");
    await writeFile(join(bookDir, "Calibre Title - Ada.pdf"), "pdf bytes");
    await writeFile(join(bookDir, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const before = await stat(dbPath);

    const takioDb = join(root, "takio.sqlite");
    const store = new BunSqliteLibraryStore(takioDb);
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    const report = await importCalibreLibrary(store, root);
    const listed = await store.list({});
    const duplicateReport = await importCalibreLibrary(store, root);
    store.close();

    expect(report.counts).toEqual({ total: 1, imported: 1, skipped: 0, duplicates: 0, failed: 0 });
    expect(duplicateReport.counts).toEqual({ total: 1, imported: 0, skipped: 0, duplicates: 1, failed: 0 });
    expect(duplicateReport.outcomes[0]).toMatchObject({ status: "duplicate", reason: "existing-library" });
    expect(listed).toMatchObject({ ok: true, value: [{
      title: "Calibre Title",
      authors: [{ name: "Ada Lovelace", sortName: "Lovelace, Ada" }],
      series: "Analytical Engines",
      seriesIndex: 2.5,
      publisher: "First Publisher",
      publishedDate: "2020-05-02",
      rating: 8,
      identifiers: { isbn: "9780000000001" },
      languages: ["en"],
      tags: ["Math", "Computing"],
      description: "Important description",
      customMetadata: { reading_state: "planned" },
      formats: [{ format: "epub" }, { format: "pdf" }],
    }] });
    const after = await stat(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});
