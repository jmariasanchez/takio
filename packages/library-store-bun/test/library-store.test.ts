import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { initializationTestSeam } from "../src/initialization-test-seam.js";
import { BunSqliteLibraryStore } from "../src/index.js";
import { lifecycleTestSeam } from "../src/lifecycle-test-seam.js";

const item: LibraryItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [
    {
      sourcePath: "library/left-hand.epub",
      format: "epub",
      addedAt: "2026-07-19T09:00:00.000Z",
      provenance: "referenced",
    },
  ],
  tags: [],
};

const secondItem: LibraryItem = {
  id: "book-2",
  title: "Kindred",
  sourcePath: "library/kindred.epub",
  format: "epub",
  addedAt: "2026-07-18T13:00:00.000Z",
  formats: [
    {
      sourcePath: "library/kindred.epub",
      format: "epub",
      addedAt: "2026-07-18T13:00:00.000Z",
      provenance: "referenced",
    },
  ],
  tags: [],
};

const richItem: LibraryItem = {
  ...item,
  author: "Ursula K. Le Guin",
  authors: [
    { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
    { name: "Michael Chabon" },
  ],
  series: "Hainish Cycle",
  seriesIndex: 4.5,
  publisher: "Ace Books",
  languages: ["en-US", "fr", "zh-Hant"],
  identifiers: {
    ISBN: "9780441478125",
    isbn: "0441478123",
  },
  publishedDate: "1969-03",
  rating: 8.75,
  description: "A novel of the Hainish Cycle.",
  tags: ["Science Fiction"],
};

const migratedV1Item: LibraryItem = {
  ...item,
  formats: [{ ...item.formats[0]!, addedAt: item.addedAt }],
  author: undefined,
  description: undefined,
  coverPath: undefined,
  updatedAt: undefined,
};
const migratedV1SecondItem: LibraryItem = {
  ...secondItem,
  author: undefined,
  description: undefined,
  coverPath: undefined,
  updatedAt: undefined,
};

let directory: string;
let databasePath: string;
let stores: BunSqliteLibraryStore[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "takio-library-store-bun-"));
  databasePath = join(directory, "library.sqlite");
  stores = [];
});

afterEach(async () => {
  delete initializationTestSeam.afterVersionZeroPreflight;
  delete initializationTestSeam.duringV1ToV2Migration;
  delete initializationTestSeam.duringV2ToV3Migration;
  delete initializationTestSeam.duringV4ToV5Migration;
  delete lifecycleTestSeam.beforeManagedFileCleanup;

  const closeErrors: unknown[] = [];
  for (const store of stores) {
    try {
      store.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }

  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    closeErrors.push(error);
  }

  if (closeErrors.length > 0) {
    throw new AggregateError(closeErrors, "Test cleanup failed");
  }
});

function createStore(): BunSqliteLibraryStore {
  const store = new BunSqliteLibraryStore(databasePath);
  stores.push(store);
  return store;
}

function schemaVersion(): number | undefined {
  using database = new Database(databasePath);
  return database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
}

function formatSnapshot(format: LibraryItem["formats"][number]) {
  return {
    sourcePath: format.sourcePath,
    addedAt: format.addedAt,
    provenance: format.provenance,
  };
}

function createFrozenV1Fixture(): void {
  using database = new Database(databasePath, { create: true, strict: true });
  database.run(`
    CREATE TABLE library_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      format TEXT NOT NULL,
      added_at TEXT NOT NULL
    ) STRICT
  `);
  for (const fixtureItem of [item, secondItem]) {
    database.run(
      "INSERT INTO library_items (id, title, source_path, format, added_at) VALUES (?, ?, ?, ?, ?)",
      [
        fixtureItem.id,
        fixtureItem.title,
        fixtureItem.sourcePath,
        fixtureItem.format,
        fixtureItem.addedAt,
      ],
    );
  }
  database.run("PRAGMA user_version = 1");
}

async function createSqlFixture(filename: string): Promise<void> {
  const sql = await readFile(join(import.meta.dir, "fixtures", filename), "utf8");
  using database = new Database(databasePath, { create: true, strict: true });
  database.exec(sql);
}

describe("BunSqliteLibraryStore", () => {
  it("persists add, get, list, and remove across injected-path reopenings at schema v5", async () => {
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item })).toEqual({ ok: true, value: item });
    first.close();

    expect(schemaVersion()).toBe(5);
    using stored = new Database(databasePath, { strict: true });
    expect(
      stored
        .query<
          {
            libraryItemId: string;
            sourcePath: string;
            format: string;
            addedAt: string;
            provenance: string;
            position: number;
          },
          []
        >(`
          SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
            format, added_at AS addedAt, provenance, position
          FROM library_item_formats
        `)
        .all(),
    ).toEqual([
      {
        libraryItemId: item.id,
        sourcePath: item.sourcePath,
        format: item.format,
        addedAt: item.formats[0]!.addedAt,
        provenance: "referenced",
        position: 0,
      },
    ]);

    const second = createStore();
    expect(await second.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await second.get({ id: item.id })).toEqual({ ok: true, value: item });
    expect(await second.list({})).toEqual({ ok: true, value: [item] });
    expect(await second.remove({ id: item.id })).toEqual({
      ok: true,
      value: { item, cleanupPending: false },
    });
    second.close();

    const third = createStore();
    expect(await third.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await third.get({ id: item.id })).toEqual({ ok: true, value: null });
    expect(await third.list({})).toEqual({ ok: true, value: [] });
    third.close();

    expect(schemaVersion()).toBe(5);
    expect(stored.query("SELECT * FROM library_item_formats").all()).toEqual([]);
  });

  it("backs up and migrates the independent frozen v2 fixture without changing fields", async () => {
    await createSqlFixture("schema-v2.sql");
    const databaseBefore = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toEqual({
      ok: true,
      value: [
        {
          id: "book-v2-minimal",
          title: "Kindred",
          sourcePath: "library/kindred.mobi",
          format: "mobi",
          addedAt: "2026-07-16T08:00:00.000Z",
          formats: [
            {
              sourcePath: "library/kindred.mobi",
              format: "mobi",
              addedAt: "2026-07-16T08:00:00.000Z",
              provenance: "referenced",
            },
          ],
          tags: [],
        },
        {
          id: "book-v2-complete",
          title: "The Dispossessed",
          sourcePath: "library/the-dispossessed.epub",
          format: "epub",
          addedAt: "2026-07-17T10:15:00.000Z",
          formats: [
            {
              sourcePath: "library/the-dispossessed.epub",
              format: "epub",
              addedAt: "2026-07-17T10:15:00.000Z",
              provenance: "referenced",
            },
          ],
          author: "Ursula K. Le Guin",
          description: "An ambiguous utopia.",
          coverPath: join(directory, "covers", "the-dispossessed.png"),
          tags: ["Science Fiction", "Classic"],
          updatedAt: "2026-07-18T09:30:00.000Z",
        },
      ],
    });
    store.close();

    expect(schemaVersion()).toBe(5);
    expect(await readFile(`${databasePath}.v2.backup`)).toEqual(databaseBefore);
    using migrated = new Database(databasePath, { strict: true });
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
    expect(
      migrated
        .query<
          { libraryItemId: string; sourcePath: string; format: string; addedAt: string; position: number },
          []
        >(`
          SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
            format, added_at AS addedAt, position
          FROM library_item_formats
          ORDER BY library_item_id
        `)
        .all(),
    ).toEqual([
      {
        libraryItemId: "book-v2-complete",
        sourcePath: "library/the-dispossessed.epub",
        format: "epub",
        addedAt: "2026-07-17T10:15:00.000Z",
        position: 0,
      },
      {
        libraryItemId: "book-v2-minimal",
        sourcePath: "library/kindred.mobi",
        format: "mobi",
        addedAt: "2026-07-16T08:00:00.000Z",
        position: 0,
      },
    ]);
  });

  it("backs up and migrates frozen v4 without inventing rich metadata", async () => {
    await createSqlFixture("schema-v4.sql");
    const databaseBefore = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toEqual({
      ok: true,
      value: [
        {
          id: "book-v4-minimal",
          title: "Kindred",
          sourcePath: "library/kindred.mobi",
          format: "mobi",
          addedAt: "2026-07-11T07:00:00.000Z",
          formats: [
            {
              sourcePath: "library/kindred.mobi",
              format: "mobi",
              addedAt: "2026-07-11T07:05:00.000Z",
              provenance: "referenced",
            },
          ],
          tags: [],
        },
        {
          id: "book-v4-complete",
          title: "Parable of the Sower",
          sourcePath: "library/parable-of-the-sower.epub",
          format: "epub",
          addedAt: "2026-07-12T08:00:00.000Z",
          formats: [
            {
              sourcePath: "library/parable-of-the-sower.epub",
              format: "epub",
              addedAt: "2026-07-12T08:05:00.000Z",
              provenance: "referenced",
            },
            {
              sourcePath: "library/parable-of-the-sower.pdf",
              format: "pdf",
              addedAt: "2026-07-12T08:10:00.000Z",
              provenance: "referenced",
            },
          ],
          author: "Octavia E. Butler",
          description: "The first Earthseed novel.",
          tags: ["Science Fiction", "Classic"],
          updatedAt: "2026-07-13T09:30:00.000Z",
        },
      ],
    });
    store.close();

    expect(schemaVersion()).toBe(5);
    expect(await readFile(`${databasePath}.v4.backup`)).toEqual(databaseBefore);
    using backup = new Database(`${databasePath}.v4.backup`, { strict: true });
    expect(backup.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 4,
    });
    using migrated = new Database(databasePath, { strict: true });
    expect(migrated.query("SELECT * FROM library_item_authors").all()).toEqual([]);
    expect(migrated.query("SELECT * FROM library_item_languages").all()).toEqual([]);
    expect(migrated.query("SELECT * FROM library_item_identifiers").all()).toEqual([]);
    expect(migrated.query("SELECT * FROM saved_library_views").all()).toEqual([]);
    expect(
      migrated
        .query<{ name: string }, []>(`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'index' AND name NOT GLOB 'sqlite_*'
          ORDER BY name
        `)
        .all(),
    ).toEqual([
      { name: "library_item_authors_by_name" },
      { name: "library_item_formats_by_format" },
      { name: "library_item_languages_by_language" },
      { name: "library_item_tags_by_tag" },
      { name: "library_items_by_added_at" },
      { name: "library_items_by_author" },
      { name: "library_items_by_published_date" },
      { name: "library_items_by_rating" },
      { name: "library_items_by_series" },
      { name: "library_items_by_title" },
      { name: "library_items_by_updated_at" },
      { name: "saved_library_views_by_name" },
    ]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
  });

  it("rolls frozen v4 back byte-for-byte when v5 migration is interrupted", async () => {
    await createSqlFixture("schema-v4.sql");
    const databaseBefore = await readFile(databasePath);
    initializationTestSeam.duringV4ToV5Migration = () => {
      throw new Error("injected v4-to-v5 migration failure");
    };

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    expect(await readFile(databasePath)).toEqual(databaseBefore);
    expect(await readFile(`${databasePath}.v4.backup`)).toEqual(databaseBefore);
    expect(schemaVersion()).toBe(4);
    using rolledBack = new Database(databasePath, { strict: true });
    expect(
      rolledBack
        .query<{ name: string }, []>("PRAGMA table_info(library_items)")
        .all()
        .map(({ name }) => name),
    ).not.toContain("series");
    expect(
      rolledBack
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).not.toContainEqual({ name: "library_item_authors" });
  });

  it("backs up and migrates a frozen v1 library without changing original fields", async () => {
    createFrozenV1Fixture();

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toEqual({
      ok: true,
      value: [migratedV1SecondItem, migratedV1Item],
    });
    store.close();

    expect(schemaVersion()).toBe(5);
    using migrated = new Database(databasePath, { strict: true });
    expect(
      migrated.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated
        .query<{ libraryItemId: string; sourcePath: string; format: string; position: number }, []>(`
          SELECT library_item_id AS libraryItemId, source_path AS sourcePath, format, position
          FROM library_item_formats ORDER BY library_item_id
        `)
        .all(),
    ).toEqual([
      {
        libraryItemId: item.id,
        sourcePath: item.sourcePath,
        format: item.format,
        position: 0,
      },
      {
        libraryItemId: secondItem.id,
        sourcePath: secondItem.sourcePath,
        format: secondItem.format,
        position: 0,
      },
    ]);
    using backup = new Database(`${databasePath}.v1.backup`, { strict: true });
    expect(backup.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
      1,
    );
    expect(
      backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
    expect(
      backup
        .query<
          Pick<LibraryItem, "id" | "title" | "sourcePath" | "format" | "addedAt">,
          []
        >(`
          SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt
          FROM library_items ORDER BY rowid
        `)
        .all(),
    ).toEqual([
      {
        id: item.id,
        title: item.title,
        sourcePath: item.sourcePath,
        format: item.format,
        addedAt: item.addedAt,
      },
      {
        id: secondItem.id,
        title: secondItem.title,
        sourcePath: secondItem.sourcePath,
        format: secondItem.format,
        addedAt: secondItem.addedAt,
      },
    ]);
  });

  it("treats reopening v5 as a no-op", async () => {
    createFrozenV1Fixture();
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    first.close();
    const backupBefore = await readFile(`${databasePath}.v1.backup`);
    const databaseBefore = await readFile(databasePath);

    const second = createStore();
    expect(await second.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await second.list({})).toEqual({
      ok: true,
      value: [migratedV1SecondItem, migratedV1Item],
    });
    second.close();

    expect(await readFile(`${databasePath}.v1.backup`)).toEqual(backupBefore);
    expect(await readFile(databasePath)).toEqual(databaseBefore);
  });

  it("rolls a v1 library back when the v2-to-v3 migration is interrupted", async () => {
    createFrozenV1Fixture();
    const databaseBefore = await readFile(databasePath);
    initializationTestSeam.duringV2ToV3Migration = () => {
      throw new Error("injected migration failure");
    };

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await readFile(databasePath)).toEqual(databaseBefore);

    using database = new Database(databasePath, { strict: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
      1,
    );
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "library_items" }]);
    expect(database.query<{ id: string }, []>("SELECT id FROM library_items ORDER BY rowid").all()).toEqual([
      { id: item.id },
      { id: secondItem.id },
    ]);
  });

  it("rolls a frozen v2 library back when the v2-to-v3 migration is interrupted", async () => {
    await createSqlFixture("schema-v2.sql");
    const databaseBefore = await readFile(databasePath);
    initializationTestSeam.duringV2ToV3Migration = () => {
      throw new Error("injected migration failure");
    };

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    expect(await readFile(databasePath)).toEqual(databaseBefore);
    expect(await readFile(`${databasePath}.v2.backup`)).toEqual(databaseBefore);
    using database = new Database(databasePath, { strict: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "library_item_tags" },
      { name: "library_items" },
      { name: "tags" },
    ]);
    expect(
      database.query<{ id: string }, []>("SELECT id FROM library_items ORDER BY rowid").all(),
    ).toEqual([{ id: "book-v2-complete" }, { id: "book-v2-minimal" }]);
  });

  it("maps duplicate primary keys to the contract error", async () => {
    const store = createStore();
    await store.open({ config: {} });

    expect(await store.add({ item })).toEqual({ ok: true, value: item });
    expect(await store.add({ item })).toEqual({ ok: false, error: { code: "duplicate-id" } });
    store.close();
  });

  it("rolls back the parent item when its primary format cannot be inserted", async () => {
    const store = createStore();
    await store.open({ config: {} });
    using database = new Database(databasePath);
    database.run(`
      CREATE TRIGGER reject_primary_format
      BEFORE INSERT ON library_item_formats
      BEGIN
        SELECT RAISE(ABORT, 'injected format failure');
      END
    `);

    expect(await store.add({ item })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(database.query("SELECT * FROM library_items").all()).toEqual([]);
    expect(database.query("SELECT * FROM library_item_formats").all()).toEqual([]);
  });

  it("runtime-validates format replacement and treats missing or stale snapshots as changed", async () => {
    const replacementPath = join(directory, "replacement.epub");
    const pdfReplacementPath = join(directory, "replacement.pdf");
    await writeFile(replacementPath, "replacement");
    await writeFile(pdfReplacementPath, "pdf replacement");
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });

    expect(
      await store.replaceFormat({
        id: item.id,
        format: "epub",
        expectedCurrent: formatSnapshot(item.formats[0]!),
        source: {
          kind: "reference",
          path: replacementPath,
          expectedArtifact: { bytes: 11, sha256: "a".repeat(64) },
        },
      } as never),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(
      await store.replaceFormat({
        id: item.id,
        format: "pdf",
        expectedCurrent: {
          sourcePath: "library/missing.pdf",
          addedAt: item.formats[0]!.addedAt,
          provenance: "referenced",
        },
        source: { kind: "reference", path: pdfReplacementPath },
      }),
    ).toEqual({ ok: false, error: { code: "format-changed" } });
    expect(
      await store.replaceFormat({
        id: "missing",
        format: "epub",
        expectedCurrent: formatSnapshot(item.formats[0]!),
        source: { kind: "reference", path: replacementPath },
      }),
    ).toEqual({ ok: false, error: { code: "format-changed" } });
    expect(
      await store.replaceFormat({
        id: item.id,
        format: "epub",
        expectedCurrent: {
          ...formatSnapshot(item.formats[0]!),
          addedAt: "2026-07-18T00:00:00.000Z",
        },
        source: { kind: "reference", path: replacementPath },
      }),
    ).toEqual({ ok: false, error: { code: "format-changed" } });
    expect(await store.get({ id: item.id })).toEqual({ ok: true, value: item });
  });

  it("allows only one copied replacement to win a strict CAS", async () => {
    const firstPath = join(directory, "first-replacement.epub");
    const secondPath = join(directory, "second-replacement.epub");
    await writeFile(firstPath, "first replacement");
    await writeFile(secondPath, "second replacement");
    const firstStore = createStore();
    const secondStore = createStore();
    await firstStore.open({ config: {} });
    await secondStore.open({ config: {} });
    await firstStore.add({ item });

    const [winner, stale] = await Promise.all([
      firstStore.replaceFormat({
        id: item.id,
        format: "epub",
        expectedCurrent: formatSnapshot(item.formats[0]!),
        source: { kind: "copy", path: firstPath },
      }),
      secondStore.replaceFormat({
        id: item.id,
        format: "epub",
        expectedCurrent: formatSnapshot(item.formats[0]!),
        source: { kind: "copy", path: secondPath },
      }),
    ]);
    expect(stale).toEqual({ ok: false, error: { code: "format-changed" } });
    if (!winner.ok || !winner.value.item) {
      throw new Error("Expected one copied replacement to win");
    }
    expect(winner.value.cleanupPending).toBe(false);
    expect(winner.value.item.id).toBe(item.id);
    expect(winner.value.item.sourcePath).toEndWith(".epub");
    expect(winner.value.item.format).toBe("epub");
    expect(winner.value.item.formats).toMatchObject([
      { format: "epub", provenance: "managed" },
    ]);
    expect(await secondStore.get({ id: item.id })).toEqual({
      ok: true,
      value: winner.value.item,
    });
    expect(await readdir(join(directory, "items"))).toEqual([
      basename(winner.value.item.sourcePath),
    ]);
    expect(await readFile(winner.value.item.sourcePath)).toEqual(Buffer.from("first replacement"));
    expect(await readFile(firstPath)).toEqual(Buffer.from("first replacement"));
    expect(await readFile(secondPath)).toEqual(Buffer.from("second replacement"));
  });

  it("preserves format positions and primary aliases while deferring safe managed cleanup", async () => {
    const originalPath = join(directory, "original.epub");
    const replacementPath = join(directory, "replacement.epub");
    const pdfPath = join(directory, "companion.pdf");
    await writeFile(originalPath, "original");
    await writeFile(replacementPath, "replacement");
    await writeFile(pdfPath, "pdf");
    const canonicalReplacementPath = await realpath(replacementPath);
    const canonicalPdfPath = await realpath(pdfPath);
    const store = createStore();
    await store.open({ config: {} });
    const imported = await store.import({ sourcePath: originalPath });
    if (!imported.ok) {
      throw new Error("Expected a managed import");
    }
    const attached = await store.attachFormat({
      id: imported.value.id,
      source: { kind: "reference", path: pdfPath },
    });
    if (!attached.ok || !attached.value) {
      throw new Error("Expected a secondary format");
    }
    const ownedPath = imported.value.sourcePath;
    lifecycleTestSeam.beforeManagedFileCleanup = (path) => {
      if (path === ownedPath) {
        throw new Error("injected cleanup failure");
      }
    };

    const replaced = await store.replaceFormat({
      id: imported.value.id,
      format: "epub",
      expectedCurrent: formatSnapshot(attached.value.formats[0]!),
      source: { kind: "reference", path: replacementPath },
    });
    expect(replaced).toMatchObject({
      ok: true,
      value: {
        item: {
          id: imported.value.id,
          sourcePath: canonicalReplacementPath,
          format: "epub",
          formats: [
            { sourcePath: canonicalReplacementPath, format: "epub", provenance: "referenced" },
            { sourcePath: canonicalPdfPath, format: "pdf", provenance: "referenced" },
          ],
        },
        cleanupPending: true,
      },
    });
    if (!replaced.ok || !replaced.value.item) {
      throw new Error("Expected the managed format replacement");
    }
    expect(await Bun.file(ownedPath).exists()).toBe(true);
    expect(await readFile(replacementPath)).toEqual(Buffer.from("replacement"));
    using database = new Database(databasePath, { strict: true });
    expect(
      database
        .query<{ format: string; position: number }, []>(
          "SELECT format, position FROM library_item_formats ORDER BY position",
        )
        .all(),
    ).toEqual([
      { format: "epub", position: 0 },
      { format: "pdf", position: 1 },
    ]);

    delete lifecycleTestSeam.beforeManagedFileCleanup;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(ownedPath).exists()).toBe(false);
    expect(await reopened.get({ id: imported.value.id })).toEqual({
      ok: true,
      value: replaced.value.item,
    });
  });

  it("preserves a managed file when its replacement references the same path", async () => {
    const originalPath = join(directory, "original.epub");
    await writeFile(originalPath, "original");
    const store = createStore();
    await store.open({ config: {} });
    const imported = await store.import({ sourcePath: originalPath });
    if (!imported.ok) {
      throw new Error("Expected a managed import");
    }
    const ownedPath = imported.value.sourcePath;
    const canonicalOwnedPath = await realpath(ownedPath);

    const replaced = await store.replaceFormat({
      id: imported.value.id,
      format: "epub",
      expectedCurrent: formatSnapshot(imported.value.formats[0]!),
      source: { kind: "reference", path: ownedPath },
    });
    expect(replaced).toMatchObject({
      ok: true,
      value: {
        item: {
          id: imported.value.id,
          sourcePath: canonicalOwnedPath,
          format: "epub",
          formats: [
            { sourcePath: canonicalOwnedPath, format: "epub", provenance: "referenced" },
          ],
        },
        cleanupPending: false,
      },
    });
    if (!replaced.ok || !replaced.value.item) {
      throw new Error("Expected the same-path replacement");
    }
    expect(await readFile(ownedPath)).toEqual(Buffer.from("original"));
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM managed_file_cleanup").all()).toEqual([]);

    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await readFile(ownedPath)).toEqual(Buffer.from("original"));
    expect(await reopened.get({ id: imported.value.id })).toEqual({
      ok: true,
      value: replaced.value.item,
    });
  });

  it("rolls replacement metadata back and removes an unpublished managed candidate", async () => {
    const replacementPath = join(directory, "replacement.epub");
    await writeFile(replacementPath, "replacement");
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    using database = new Database(databasePath, { strict: true });
    database.run(`
      CREATE TRIGGER reject_format_replacement
      BEFORE UPDATE OF source_path ON library_item_formats
      BEGIN
        SELECT RAISE(ABORT, 'injected replacement failure');
      END
    `);

    expect(
      await store.replaceFormat({
        id: item.id,
        format: "epub",
        expectedCurrent: formatSnapshot(item.formats[0]!),
        source: { kind: "copy", path: replacementPath },
      }),
    ).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(await store.get({ id: item.id })).toEqual({ ok: true, value: item });
    expect(await readdir(join(directory, "items"))).toEqual([]);
    expect(database.query("SELECT * FROM managed_file_cleanup").all()).toEqual([]);
    expect(await readFile(replacementPath)).toEqual(Buffer.from("replacement"));
  });

  it("updates only editable metadata and replaces tags across close and reopen", async () => {
    const first = createStore();
    await first.open({ config: {} });
    await first.add({ item });

    const result = await first.update({
      id: item.id,
      patch: {
        title: "  Left Hand  ",
        author: "  Ursula K. Le Guin  ",
        description: "  A classic.  ",
        tags: ["  Science   Fiction  ", "Classic"],
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...item,
        title: "Left Hand",
        author: "Ursula K. Le Guin",
        description: "A classic.",
        tags: ["Science Fiction", "Classic"],
        updatedAt: expect.any(String),
      },
    });
    if (!result.ok || !result.value) {
      throw new Error("Expected the updated item");
    }
    expect({
      id: result.value.id,
      sourcePath: result.value.sourcePath,
      format: result.value.format,
      addedAt: result.value.addedAt,
    }).toEqual({
      id: item.id,
      sourcePath: item.sourcePath,
      format: item.format,
      addedAt: item.addedAt,
    });
    first.close();

    const reopened = createStore();
    await reopened.open({ config: {} });
    expect(await reopened.get({ id: item.id })).toEqual(result);
    expect(
      await reopened.update({
        id: item.id,
        patch: { author: null, description: null, tags: [] },
      }),
    ).toMatchObject({
      ok: true,
      value: { author: undefined, description: undefined, tags: [] },
    });
  });

  it("atomically replaces rich metadata in order and persists it across every read path", async () => {
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item: richItem })).toEqual({ ok: true, value: richItem });

    const updated = await first.update({
      id: richItem.id,
      patch: {
        title: "  The Dispossessed  ",
        author: "This legacy value is ignored",
        authors: [
          { name: "  Octavia E. Butler  ", sortName: "  Butler, Octavia E.  " },
          { name: "Samuel R. Delany" },
        ],
        series: "  Hainish Novels  ",
        seriesIndex: 6,
        publisher: "  Harper & Row  ",
        languages: ["fr", "en-US"],
        identifiers: { isbn: "9780061054884", goodreads: "13651" },
        publishedDate: "1974-05-01",
        rating: 9.25,
        description: "  An anarchist utopia.  ",
        tags: ["  Science   Fiction  ", "Award Winner"],
      },
    });
    expect(updated).toEqual({
      ok: true,
      value: {
        ...richItem,
        title: "The Dispossessed",
        author: "Octavia E. Butler, Samuel R. Delany",
        authors: [
          { name: "Octavia E. Butler", sortName: "Butler, Octavia E." },
          { name: "Samuel R. Delany" },
        ],
        series: "Hainish Novels",
        seriesIndex: 6,
        publisher: "Harper & Row",
        languages: ["fr", "en-US"],
        identifiers: { goodreads: "13651", isbn: "9780061054884" },
        publishedDate: "1974-05-01",
        rating: 9.25,
        description: "An anarchist utopia.",
        tags: ["Science Fiction", "Award Winner"],
        updatedAt: expect.any(String),
      },
    });
    if (!updated.ok || !updated.value) {
      throw new Error("Expected rich metadata replacement");
    }

    expect(await first.get({ id: richItem.id })).toEqual(updated);
    expect(await first.list({})).toEqual({ ok: true, value: [updated.value] });
    expect(await first.search({ query: "Samuel R. Delany" })).toEqual({
      ok: true,
      value: [updated.value],
    });
    expect(
      await first.query({
        query: "9780061054884",
        filters: {
          authors: ["Samuel R. Delany"],
          tags: ["Award Winner"],
          series: ["Hainish Novels"],
          languages: ["fr"],
          formats: ["epub"],
        },
        sort: { field: "title", direction: "ascending" },
        page: { offset: 0, limit: 10 },
      }),
    ).toMatchObject({ ok: true, value: { items: [updated.value], total: 1 } });

    using stored = new Database(databasePath, { strict: true });
    expect(
      stored
        .query("SELECT name, sort_name, position FROM library_item_authors ORDER BY position")
        .all(),
    ).toEqual([
      { name: "Octavia E. Butler", sort_name: "Butler, Octavia E.", position: 0 },
      { name: "Samuel R. Delany", sort_name: null, position: 1 },
    ]);
    expect(
      stored
        .query("SELECT language, position FROM library_item_languages ORDER BY position")
        .all(),
    ).toEqual([
      { language: "fr", position: 0 },
      { language: "en-US", position: 1 },
    ]);
    first.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: richItem.id })).toEqual(updated);
  });

  it("clears every nullable metadata field and relation", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.add({ item: richItem })).toEqual({ ok: true, value: richItem });

    const cleared = await store.update({
      id: richItem.id,
      patch: {
        author: null,
        authors: null,
        series: null,
        seriesIndex: null,
        publisher: null,
        languages: null,
        identifiers: null,
        publishedDate: null,
        rating: null,
        description: null,
        tags: [],
      },
    });
    expect(cleared).toEqual({
      ok: true,
      value: {
        id: richItem.id,
        title: richItem.title,
        sourcePath: richItem.sourcePath,
        format: richItem.format,
        addedAt: richItem.addedAt,
        formats: richItem.formats,
        tags: [],
        updatedAt: expect.any(String),
      },
    });

    using stored = new Database(databasePath, { strict: true });
    expect(stored.query("SELECT * FROM library_item_authors").all()).toEqual([]);
    expect(stored.query("SELECT * FROM library_item_languages").all()).toEqual([]);
    expect(stored.query("SELECT * FROM library_item_identifiers").all()).toEqual([]);
  });

  it("rejects invalid metadata patches before changing stored data", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.add({ item: richItem })).toEqual({ ok: true, value: richItem });

    expect(
      await store.update({
        id: richItem.id,
        patch: { rating: 11, tags: [] } as never,
      }),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(await store.get({ id: richItem.id })).toEqual({ ok: true, value: richItem });
  });

  it("preserves rich metadata ordering and date precision through legacy updates and reopen", async () => {
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item: richItem })).toEqual({ ok: true, value: richItem });

    const updated = await first.update({
      id: richItem.id,
      patch: {
        author: "U. K. Le Guin",
        tags: ["Classic"],
      },
    });
    expect(updated).toEqual({
      ok: true,
      value: {
        ...richItem,
        author: "U. K. Le Guin",
        tags: ["Classic"],
        updatedAt: expect.any(String),
      },
    });
    if (!updated.ok || !updated.value) {
      throw new Error("Expected a rich metadata item");
    }

    using stored = new Database(databasePath, { strict: true });
    expect(
      stored
        .query<{ name: string; sortName: string | null; position: number }, []>(`
          SELECT name, sort_name AS sortName, position
          FROM library_item_authors
          ORDER BY position
        `)
        .all(),
    ).toEqual([
      { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K.", position: 0 },
      { name: "Michael Chabon", sortName: null, position: 1 },
    ]);
    expect(
      stored
        .query<{ language: string; position: number }, []>(`
          SELECT language, position
          FROM library_item_languages
          ORDER BY position
        `)
        .all(),
    ).toEqual([
      { language: "en-US", position: 0 },
      { language: "fr", position: 1 },
      { language: "zh-Hant", position: 2 },
    ]);
    expect(
      stored
        .query<{ publishedDate: string }, []>(`
          SELECT published_date AS publishedDate
          FROM library_items
        `)
        .get(),
    ).toEqual({ publishedDate: "1969-03" });
    first.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: richItem.id })).toEqual(updated);
  });

  it("rolls scalar and relation changes back together when a child write fails", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item: richItem });
    const before = await store.get({ id: richItem.id });

    using database = new Database(databasePath);
    database.run(`
      CREATE TRIGGER reject_language_replacement
      BEFORE INSERT ON library_item_languages
      BEGIN
        SELECT RAISE(ABORT, 'injected language failure');
      END
    `);
    expect(
      await store.update({
        id: richItem.id,
        patch: {
          title: "Changed",
          authors: [{ name: "Changed Author" }],
          series: "Changed Series",
          languages: ["de"],
          identifiers: { isbn: "changed" },
          tags: ["Changed"],
        },
      }),
    ).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(await store.get({ id: richItem.id })).toEqual(before);
  });

  it("searches metadata and tags literally with stable, duplicate-free ordering", async () => {
    const store = createStore();
    await store.open({ config: {} });
    const fixtures: LibraryItem[] = [
      { ...item, id: "percent", title: "100% Real", tags: ["Classic"] },
      { ...item, id: "underscore", title: "Under_score", tags: [] },
      { ...item, id: "slash", title: "Back\\slash", tags: [] },
      {
        ...item,
        id: "alpha-2",
        title: "alpha",
        author: "OCTAVIA BUTLER",
        description: "Classic speculative fiction",
        tags: ["Classic"],
      },
      { ...item, id: "alpha-1", title: "Alpha", tags: ["Solo"] },
    ];
    for (const fixture of fixtures) {
      await store.add({ item: fixture });
    }

    expect(await store.search({ query: "%" })).toMatchObject({
      ok: true,
      value: [{ id: "percent" }],
    });
    expect(await store.search({ query: "_" })).toMatchObject({
      ok: true,
      value: [{ id: "underscore" }],
    });
    expect(await store.search({ query: "\\" })).toMatchObject({
      ok: true,
      value: [{ id: "slash" }],
    });
    expect(await store.search({ query: "classic" })).toMatchObject({
      ok: true,
      value: [{ id: "percent" }, { id: "alpha-2" }],
    });
    expect(await store.search({ query: "alpha" })).toMatchObject({
      ok: true,
      value: [{ id: "alpha-1" }, { id: "alpha-2" }],
    });
    expect(await store.search({ query: "octavia" })).toMatchObject({
      ok: true,
      value: [{ id: "alpha-2" }],
    });
    expect(await store.search({ query: "" })).toEqual(await store.list({}));
  });

  it("copies, replaces, persists, and removes owned covers without changing originals", async () => {
    const firstSource = join(directory, "selected-one.png");
    const secondSource = join(directory, "selected-two.jpg");
    await writeFile(firstSource, "first-original");
    await writeFile(secondSource, "second-original");
    const firstOriginal = await readFile(firstSource);
    const secondOriginal = await readFile(secondSource);

    const first = createStore();
    await first.open({ config: {} });
    await first.add({ item });
    const installed = await first.setCover({ id: item.id, sourcePath: firstSource });
    expect(installed).toMatchObject({ ok: true, value: { id: item.id } });
    if (!installed.ok || !installed.value?.coverPath) {
      throw new Error("Expected an installed cover");
    }
    const firstOwnedPath = installed.value.coverPath;
    expect(await readFile(firstOwnedPath)).toEqual(firstOriginal);
    expect(await readFile(firstSource)).toEqual(firstOriginal);
    using storedCover = new Database(databasePath);
    expect(
      storedCover
        .query<{ coverPath: string }, [string]>(
          "SELECT cover_path AS coverPath FROM library_items WHERE id = ?",
        )
        .get(item.id)?.coverPath,
    ).toBe(basename(firstOwnedPath));
    first.close();

    const reopened = createStore();
    await reopened.open({ config: {} });
    expect(await reopened.get({ id: item.id })).toEqual(installed);
    const replaced = await reopened.setCover({ id: item.id, sourcePath: secondSource });
    if (!replaced.ok || !replaced.value?.coverPath) {
      throw new Error("Expected a replaced cover");
    }
    expect(await Bun.file(firstOwnedPath).exists()).toBe(false);
    expect(await readFile(replaced.value.coverPath)).toEqual(secondOriginal);
    expect(await readFile(secondSource)).toEqual(secondOriginal);

    const removedCover = await reopened.removeCover({ id: item.id });
    expect(removedCover).toMatchObject({ ok: true, value: { id: item.id } });
    expect(removedCover.ok && removedCover.value?.coverPath).toBeUndefined();
    expect(await Bun.file(replaced.value.coverPath).exists()).toBe(false);
    expect(await readFile(firstSource)).toEqual(firstOriginal);
    expect(await readFile(secondSource)).toEqual(secondOriginal);
  });

  it("keeps the prior cover pair when replacement cannot update SQLite", async () => {
    const firstSource = join(directory, "first.png");
    const secondSource = join(directory, "second.png");
    await writeFile(firstSource, "first");
    await writeFile(secondSource, "second");
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    const firstCover = await store.setCover({ id: item.id, sourcePath: firstSource });
    if (!firstCover.ok || !firstCover.value?.coverPath) {
      throw new Error("Expected a first cover");
    }

    using database = new Database(databasePath);
    database.run(`
      CREATE TRIGGER reject_cover_replacement
      BEFORE UPDATE OF cover_path ON library_items
      BEGIN
        SELECT RAISE(ABORT, 'injected cover failure');
      END
    `);
    expect(await store.setCover({ id: item.id, sourcePath: secondSource })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await store.get({ id: item.id })).toEqual(firstCover);
    expect(await readFile(firstCover.value.coverPath)).toEqual(Buffer.from("first"));
    expect(await readdir(join(directory, "covers"))).toEqual([
      basename(firstCover.value.coverPath),
    ]);
    expect(await readFile(secondSource)).toEqual(Buffer.from("second"));
  });

  it("rejects cover traversal and deletes only the owned cover when removing an item", async () => {
    const outsidePath = join(directory, "outside.png");
    await writeFile(outsidePath, "outside");
    const store = createStore();
    await store.open({ config: {} });
    expect(await store.add({ item: { ...item, coverPath: outsidePath } })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    await store.add({ item });
    store.close();

    using database = new Database(databasePath);
    database.run("UPDATE library_items SET cover_path = '../outside.png' WHERE id = ?", [item.id]);
    const rejected = createStore();
    await rejected.open({ config: {} });
    expect(await rejected.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await rejected.remove({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await readFile(outsidePath)).toEqual(Buffer.from("outside"));

    rejected.close();
    database.run("UPDATE library_items SET cover_path = NULL WHERE id = ?", [item.id]);
    const owner = createStore();
    await owner.open({ config: {} });
    const installed = await owner.setCover({ id: item.id, sourcePath: outsidePath });
    if (!installed.ok || !installed.value?.coverPath) {
      throw new Error("Expected an owned cover");
    }
    expect(await owner.remove({ id: item.id })).toMatchObject({
      ok: true,
      value: { item: { id: item.id }, cleanupPending: false },
    });
    expect(await Bun.file(installed.value.coverPath).exists()).toBe(false);
    expect(await readFile(outsidePath)).toEqual(Buffer.from("outside"));
  });

  it("reports a malformed primary format row when the item is read", async () => {
    const store = createStore();
    await store.open({ config: {} });
    store.close();

    using database = new Database(databasePath);
    database.run(
      "INSERT INTO library_items (id, title, added_at) VALUES (?, ?, ?)",
      [item.id, item.title, item.addedAt],
    );
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position)
        VALUES (?, ?, ?, ?, 'referenced', 0)`,
      [item.id, "invalid-format", item.sourcePath, item.addedAt],
    );
    const before = await readFile(databasePath);

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await reopened.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("reports an item without a position-zero format when the item is read", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    store.close();

    using database = new Database(databasePath);
    database.run("DELETE FROM library_item_formats WHERE library_item_id = ?", [item.id]);
    const before = await readFile(databasePath);

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect(database.query("SELECT id FROM library_items").all()).toEqual([{ id: item.id }]);
  });

  it("reports an invalid secondary format when the item is read", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    store.close();

    using database = new Database(databasePath);
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position)
        VALUES (?, 'pdf', ?, 'not-a-date', 'referenced', 1)`,
      [item.id, "library/left-hand.pdf"],
    );
    const before = await readFile(databasePath);

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await reopened.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("rejects future schemas byte-for-byte without mutation", async () => {
    await createSqlFixture("schema-future.sql");
    const before = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "incompatible-schema" },
    });
    expect(await readFile(databasePath)).toEqual(before);
    using database = new Database(databasePath, { strict: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 999,
    });
    expect(
      database
        .query<{ id: string; payload: string }, []>(
          "SELECT id, payload FROM future_library_records",
        )
        .all(),
    ).toEqual([
      { id: "future-record", payload: "must remain byte-for-byte unchanged" },
    ]);
  });

  it("rejects a nonempty version-0 database without claiming or mutating it", async () => {
    using database = new Database(databasePath);
    database.run("CREATE TABLE caller_owned (id TEXT PRIMARY KEY)");
    const schemaBefore = database
      .query<{ name: string; type: string }, []>(
        "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all();
    database.close();

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "incompatible-schema" },
    });

    using rejectedDatabase = new Database(databasePath);
    expect(
      rejectedDatabase.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(0);
    expect(
      rejectedDatabase
        .query<{ name: string; type: string }, []>(
          "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
    ).toEqual(schemaBefore);
  });

  it("holds the initialization lock between version-0 preflight and schema creation", async () => {
    using competitor = new Database(databasePath, { create: true, strict: true });
    let competingAttempts = 0;
    let competingError: unknown;
    initializationTestSeam.afterVersionZeroPreflight = () => {
      competingAttempts += 1;
      try {
        competitor.run("CREATE TABLE injected_between_preflight_and_initialization (id TEXT)");
      } catch (error) {
        competingError = error;
      }
    };

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(competingAttempts).toBe(1);
    expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });

    using initializedDatabase = new Database(databasePath);
    expect(
      initializedDatabase.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(5);
    expect(
      initializedDatabase
        .query<{ name: string; type: string }, []>(
          `SELECT name, type FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
            ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "library_item_authors", type: "table" },
      { name: "library_item_formats", type: "table" },
      { name: "library_item_identifiers", type: "table" },
      { name: "library_item_languages", type: "table" },
      { name: "library_item_tags", type: "table" },
      { name: "library_items", type: "table" },
      { name: "managed_file_cleanup", type: "table" },
      { name: "saved_library_views", type: "table" },
      { name: "tags", type: "table" },
    ]);
  });

  it("reports malformed metadata and tag rows instead of leaking partial items", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    store.close();

    using database = new Database(databasePath);
    database.run("UPDATE library_items SET author = '   ' WHERE id = ?", [item.id]);
    const malformedMetadata = createStore();
    expect(await malformedMetadata.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedMetadata.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    malformedMetadata.close();

    database.run("UPDATE library_items SET author = NULL WHERE id = ?", [item.id]);
    database.run("INSERT INTO tags (normalized_name, name) VALUES ('blank', '   ')");
    database.run(
      "INSERT INTO library_item_tags (library_item_id, tag_normalized_name, position) VALUES (?, 'blank', 0)",
      [item.id],
    );
    const malformedTag = createStore();
    expect(await malformedTag.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedTag.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
  });

  it("reports malformed rich metadata without normalizing or dropping it", async () => {
    const initializer = createStore();
    await initializer.open({ config: {} });
    await initializer.add({ item: richItem });
    initializer.close();

    using database = new Database(databasePath, { strict: true });
    database.run("UPDATE library_items SET published_date = '1969-13' WHERE id = ?", [
      richItem.id,
    ]);
    const malformedDate = createStore();
    expect(await malformedDate.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedDate.get({ id: richItem.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    malformedDate.close();

    database.run("UPDATE library_items SET published_date = '1969-03' WHERE id = ?", [
      richItem.id,
    ]);
    database.run(
      "UPDATE library_item_authors SET position = 3 WHERE library_item_id = ? AND position = 1",
      [richItem.id],
    );
    const malformedAuthorOrder = createStore();
    expect(await malformedAuthorOrder.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedAuthorOrder.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    malformedAuthorOrder.close();

    database.run(
      "UPDATE library_item_authors SET position = 1 WHERE library_item_id = ? AND position = 3",
      [richItem.id],
    );
    database.run(
      "UPDATE library_item_languages SET position = 4 WHERE library_item_id = ? AND position = 2",
      [richItem.id],
    );
    const malformedLanguageOrder = createStore();
    expect(await malformedLanguageOrder.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedLanguageOrder.get({ id: richItem.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    malformedLanguageOrder.close();

    database.run(
      "UPDATE library_item_languages SET position = 2 WHERE library_item_id = ? AND position = 4",
      [richItem.id],
    );
    database.run(
      "UPDATE library_item_identifiers SET scheme = ' ISBN ' WHERE library_item_id = ? AND scheme = 'ISBN'",
      [richItem.id],
    );
    const malformedIdentifier = createStore();
    expect(await malformedIdentifier.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await malformedIdentifier.get({ id: richItem.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
  });

  it("requires the caller to inject a database path", () => {
    expect(() => new BunSqliteLibraryStore("")).toThrow("A database path is required.");
  });
});
