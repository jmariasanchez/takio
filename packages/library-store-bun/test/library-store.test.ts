import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { FORMAT_IDS, type LibraryItem } from "@takio/core";

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
  delete lifecycleTestSeam.afterAdoptionJournalPlanned;
  delete lifecycleTestSeam.afterAdoptionFinalizing;
  delete lifecycleTestSeam.afterAdoptionRenamed;
  delete lifecycleTestSeam.beforeAdoptionRename;
  delete lifecycleTestSeam.sameDevicePreflight;
  delete lifecycleTestSeam.beforeSourceFileCleanup;
  delete lifecycleTestSeam.duringManagedItemRemoval;

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

async function createSchemaV9Fixture(): Promise<Buffer> {
  const store = createStore();
  expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
  expect(await store.add({ item })).toEqual({ ok: true, value: item });
  store.close();
  using database = new Database(databasePath, { strict: true });
  database.run("DROP INDEX library_adoptions_by_state");
  database.run("DROP TABLE library_adoptions");
  database.run("PRAGMA user_version = 9");
  database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return readFile(databasePath);
}

describe("BunSqliteLibraryStore", () => {
  it("adopts one source into managed storage without retaining a duplicate", async () => {
    const sourcePath = join(directory, "adopt-me.epub");
    await writeFile(sourcePath, "adopted contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });

    const adopted = await store.adopt({ sourcePath });

    expect(adopted).toMatchObject({
      ok: true,
      value: {
        item: { title: "adopt-me", format: "epub", formats: [{ provenance: "managed" }] },
        sourceCleanupPending: false,
      },
    });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
    if (!adopted.ok) throw new Error("Expected adoption to succeed");
    expect(await readFile(adopted.value.item.sourcePath)).toEqual(Buffer.from("adopted contents"));
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("fails cross-device adoption without copy-delete fallback", async () => {
    const sourcePath = join(directory, "cross-device.epub");
    await writeFile(sourcePath, "cross device contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.sameDevicePreflight = () => false;

    expect(await store.adopt({ sourcePath })).toMatchObject({ ok: false, error: { code: "cross-device-move" } });

    expect(await Bun.file(sourcePath).exists()).toBe(true);
    expect(await readFile(sourcePath)).toEqual(Buffer.from("cross device contents"));
    expect(await readdir(join(directory, "items"))).toEqual([]);
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("keeps the source when a rename race reports EXDEV after the journal is planned", async () => {
    const sourcePath = join(directory, "race-cross-device.epub");
    await writeFile(sourcePath, "race cross device contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.beforeAdoptionRename = () => {
      const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    };

    expect(await store.adopt({ sourcePath })).toMatchObject({ ok: false, error: { code: "cross-device-move" } });

    expect(await Bun.file(sourcePath).exists()).toBe(true);
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("recovers an adoption interrupted while pending rename", async () => {
    const sourcePath = join(directory, "planned.epub");
    await writeFile(sourcePath, "planned contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.afterAdoptionJournalPlanned = () => {
      throw new Error("interrupt after plan");
    };

    expect(await store.adopt({ sourcePath })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(await Bun.file(sourcePath).exists()).toBe(true);

    delete lifecycleTestSeam.afterAdoptionJournalPlanned;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
    const listed = await reopened.list({});
    expect(listed).toMatchObject({ ok: true, value: [{ title: "planned" }] });
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("recovers an adoption interrupted after durable rename", async () => {
    const sourcePath = join(directory, "renamed.epub");
    await writeFile(sourcePath, "renamed contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.afterAdoptionRenamed = () => {
      throw new Error("interrupt after rename");
    };

    expect(await store.adopt({ sourcePath })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(await Bun.file(sourcePath).exists()).toBe(false);

    delete lifecycleTestSeam.afterAdoptionRenamed;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    const listed = await reopened.list({});
    expect(listed).toMatchObject({ ok: true, value: [{ title: "renamed" }] });
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("recovers an adoption interrupted while finalizing library rows", async () => {
    const sourcePath = join(directory, "finalizing.epub");
    await writeFile(sourcePath, "finalizing contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.afterAdoptionFinalizing = () => {
      throw new Error("interrupt while finalizing");
    };

    expect(await store.adopt({ sourcePath })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });

    delete lifecycleTestSeam.afterAdoptionFinalizing;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    const listed = await reopened.list({});
    expect(listed).toMatchObject({ ok: true, value: [{ title: "finalizing" }] });
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
  });

  it("reports cross-device failures for batch move imports without deleting the source", async () => {
    const sourcePath = join(directory, "batch-cross-device.epub");
    await writeFile(sourcePath, "batch cross device contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.sameDevicePreflight = () => false;

    const imported = await store.importMany({ roots: [sourcePath], mode: "move" });

    expect(imported).toMatchObject({
      ok: true,
      value: {
        outcomes: [{ status: "failed", sourcePath, code: "cross-device-move" }],
        counts: { failed: 1, imported: 0 },
      },
    });
    expect(await Bun.file(sourcePath).exists()).toBe(true);
    expect(await readFile(sourcePath)).toEqual(Buffer.from("batch cross device contents"));
  });

  it("adopts an exact duplicate by removing only the redundant original", async () => {
    const firstPath = join(directory, "first.epub");
    const duplicatePath = join(directory, "duplicate.epub");
    await writeFile(firstPath, "same contents");
    await writeFile(duplicatePath, "same contents");
    const store = createStore();
    await store.open({ config: {} });
    const first = await store.import({ sourcePath: firstPath });
    if (!first.ok) throw new Error("Expected the first import");

    const adopted = await store.adopt({ sourcePath: duplicatePath });

    expect(adopted).toMatchObject({
      ok: true,
      value: { item: { id: first.value.id }, sourceCleanupPending: false },
    });
    expect(await Bun.file(duplicatePath).exists()).toBe(false);
    expect(await store.list({})).toMatchObject({ ok: true, value: [{ id: first.value.id }] });
  });

  it("persists duplicate adoption source cleanup and retries it when the library reopens", async () => {
    const firstPath = join(directory, "duplicate-original.epub");
    const duplicatePath = join(directory, "duplicate-cleanup-later.epub");
    await writeFile(firstPath, "same retry contents");
    await writeFile(duplicatePath, "same retry contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    const first = await store.import({ sourcePath: firstPath });
    if (!first.ok) throw new Error("Expected the first import");
    lifecycleTestSeam.beforeSourceFileCleanup = () => {
      throw new Error("injected duplicate source cleanup failure");
    };

    const adopted = await store.adopt({ sourcePath: duplicatePath });

    expect(adopted).toMatchObject({ ok: true, value: { item: { id: first.value.id }, sourceCleanupPending: true } });
    expect(await Bun.file(duplicatePath).exists()).toBe(true);
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT source_path FROM source_file_cleanup").all()).toEqual([
      { source_path: await realpath(duplicatePath) },
    ]);

    delete lifecycleTestSeam.beforeSourceFileCleanup;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(duplicatePath).exists()).toBe(false);
    expect(database.query("SELECT * FROM source_file_cleanup").all()).toEqual([]);
  });

  it("moves nonduplicate adoption atomically without source-cleanup retry", async () => {
    const sourcePath = join(directory, "cleanup-later.epub");
    await writeFile(sourcePath, "cleanup later contents");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.beforeSourceFileCleanup = () => {
      throw new Error("injected source cleanup failure");
    };

    const adopted = await store.adopt({ sourcePath });

    expect(adopted).toMatchObject({ ok: true, value: { sourceCleanupPending: false } });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM source_file_cleanup").all()).toEqual([]);

    delete lifecycleTestSeam.beforeSourceFileCleanup;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
    expect(database.query("SELECT * FROM source_file_cleanup").all()).toEqual([]);
  });

  it("adopts a zero-byte source and removes the original", async () => {
    const sourcePath = join(directory, "empty.epub");
    await writeFile(sourcePath, "");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });

    const adopted = await store.adopt({ sourcePath });

    expect(adopted).toMatchObject({
      ok: true,
      value: { sourceCleanupPending: false },
    });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
  });

  it("moves a zero-byte source atomically without source-cleanup retry", async () => {
    const sourcePath = join(directory, "empty-cleanup-later.epub");
    await writeFile(sourcePath, "");
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    lifecycleTestSeam.beforeSourceFileCleanup = () => {
      throw new Error("injected source cleanup failure");
    };

    const adopted = await store.adopt({ sourcePath });

    expect(adopted).toMatchObject({ ok: true, value: { sourceCleanupPending: false } });
    expect(await Bun.file(sourcePath).exists()).toBe(false);

    delete lifecycleTestSeam.beforeSourceFileCleanup;
    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(sourcePath).exists()).toBe(false);
  });

  it("persists add, get, list, and remove across injected-path reopenings at schema v10", async () => {
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item })).toEqual({ ok: true, value: item });
    first.close();

    expect(schemaVersion()).toBe(10);
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

    expect(schemaVersion()).toBe(10);
    expect(stored.query("SELECT * FROM library_item_formats").all()).toEqual([]);
  });

  it("migrates schema v9 to v10 with a byte-for-byte backup and durable adoption journal", async () => {
    const databaseBefore = await createSchemaV9Fixture();
    const store = createStore();

    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });

    expect(await readFile(`${databasePath}.v9.backup`)).toEqual(databaseBefore);
    using database = new Database(databasePath, { strict: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 10,
    });
    expect(database.query("SELECT * FROM library_adoptions").all()).toEqual([]);
    database.run(
      `INSERT INTO library_adoptions
        (id, library_item_id, title, source_path, target_path, format,
          content_bytes, content_sha256, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "adoption-1",
        "preallocated-book-1",
        "Custom adoption title",
        join(directory, "source.epub"),
        join(directory, "items", "target.epub"),
        "epub",
        12,
        "a".repeat(64),
        "pending-rename",
        "2026-08-19T22:00:00.000Z",
        "2026-08-19T22:00:00.000Z",
      ],
    );
    expect(
      database
        .query<
          { libraryItemId: string; title: string; targetPath: string },
          []
        >(`
          SELECT library_item_id AS libraryItemId, title, target_path AS targetPath
          FROM library_adoptions
        `)
        .get(),
    ).toEqual({
      libraryItemId: "preallocated-book-1",
      title: "Custom adoption title",
      targetPath: join(directory, "items", "target.epub"),
    });
    expect(() =>
      database.run(
        `INSERT INTO library_adoptions
          (id, library_item_id, title, source_path, target_path, format,
            content_bytes, content_sha256, state, created_at, updated_at)
          VALUES ('bad-state', 'item-bad-state', 'Bad state', 'a', 'b', 'epub', 1, ?, 'unknown', 'now', 'now')`,
        ["b".repeat(64)],
      ),
    ).toThrow();
  });

  it("accepts every catalogue format and rejects invalid formats and duplicate targets", async () => {
    await createSchemaV9Fixture();
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    store.close();
    const database = new Database(databasePath, { strict: true });
    const insertSql = `
      INSERT INTO library_adoptions
        (id, library_item_id, title, source_path, target_path, format,
          content_bytes, content_sha256, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      for (const format of FORMAT_IDS) {
        database.run(insertSql, [
          `adoption-${format}`,
          `item-${format}`,
          `Title ${format}`,
          join(directory, `source.${format}`),
          join(directory, "items", `target.${format}`),
          format,
          1,
          "c".repeat(64),
          "pending-rename",
          "2026-08-19T22:00:00.000Z",
          "2026-08-19T22:00:00.000Z",
        ]);
      }
      expect(
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM library_adoptions").get(),
      ).toEqual({ count: FORMAT_IDS.length });
      expect(() =>
        database.run(insertSql, [
          "bad-format",
          "item-bad-format",
          "Bad format",
          join(directory, "bad.input"),
          join(directory, "items", "bad.output"),
          "lit",
          1,
          "d".repeat(64),
          "pending-rename",
          "2026-08-19T22:00:00.000Z",
          "2026-08-19T22:00:00.000Z",
        ]),
      ).toThrow();
      expect(() =>
        database.run(insertSql, [
          "duplicate-target",
          "item-duplicate-target",
          "Duplicate target",
          join(directory, "different.epub"),
          join(directory, "items", `target.${FORMAT_IDS[0]}`),
          FORMAT_IDS[0],
          1,
          "e".repeat(64),
          "pending-rename",
          "2026-08-19T22:00:00.000Z",
          "2026-08-19T22:00:00.000Z",
        ]),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("rolls back schema v10 migration when the adoption journal collides", async () => {
    await createSchemaV9Fixture();
    using collision = new Database(databasePath, { strict: true });
    collision.run("CREATE TABLE library_adoptions (legacy TEXT) STRICT");
    collision.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const withCollision = await readFile(databasePath);
    const store = createStore();

    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    expect(await readFile(databasePath)).toEqual(withCollision);
    using database = new Database(databasePath, { strict: true });
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 9,
    });
    expect(database.query("SELECT sql FROM sqlite_schema WHERE name = 'library_adoptions'").get()).toEqual({
      sql: "CREATE TABLE library_adoptions (legacy TEXT) STRICT",
    });
    expect(await readFile(`${databasePath}.v9.backup`)).toEqual(withCollision);
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

    expect(schemaVersion()).toBe(10);
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

    expect(schemaVersion()).toBe(10);
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
      { name: "library_adoptions_by_state" },
      { name: "library_item_authors_by_name" },
      { name: "library_item_formats_by_fingerprint" },
      { name: "library_item_formats_by_format" },
      { name: "library_item_languages_by_language" },
      { name: "library_item_tags_by_tag" },
      { name: "library_items_by_added_at" },
      { name: "library_items_by_author" },
      { name: "library_items_by_published_date" },
      { name: "library_items_by_rating" },
      { name: "library_items_by_series" },
      { name: "library_items_by_title" },
      { name: "library_items_by_trashed_at" },
      { name: "library_items_by_updated_at" },
      { name: "saved_library_views_by_name" },
    ]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      migrated.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
  });

  it("backs up and migrates frozen v5 with active rows and the deterministic trash index", async () => {
    await createSqlFixture("schema-v5.sql");
    const databaseBefore = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toMatchObject({
      ok: true,
      value: [{ id: "book-v5", title: "A Wizard of Earthsea" }],
    });
    store.close();

    expect(schemaVersion()).toBe(10);
    expect(await readFile(`${databasePath}.v5.backup`)).toEqual(databaseBefore);
    using migrated = new Database(databasePath, { strict: true });
    expect(
      migrated
        .query<{ trashedAt: string | null }, []>(
          "SELECT trashed_at AS trashedAt FROM library_items",
        )
        .all(),
    ).toEqual([{ trashedAt: null }]);
    expect(
      migrated
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_schema WHERE name = 'library_items_by_trashed_at'",
        )
        .get()?.sql.replace(/\s+/g, " ").trim(),
    ).toBe(
      "CREATE INDEX library_items_by_trashed_at ON library_items(trashed_at DESC, id ASC) WHERE trashed_at IS NOT NULL",
    );
  });

  it("rolls frozen v5 back byte-for-byte when the trash index cannot be created", async () => {
    await createSqlFixture("schema-v5.sql");
    {
      using database = new Database(databasePath, { strict: true });
      database.run("CREATE TABLE migration_collision (id TEXT PRIMARY KEY) STRICT");
      database.run(
        "CREATE INDEX library_items_by_trashed_at ON migration_collision(id)",
      );
    }
    const databaseBefore = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    expect(await readFile(databasePath)).toEqual(databaseBefore);
    expect(await readFile(`${databasePath}.v5.backup`)).toEqual(databaseBefore);
    expect(schemaVersion()).toBe(5);
    using rolledBack = new Database(databasePath, { strict: true });
    expect(
      rolledBack
        .query<{ name: string }, []>("PRAGMA table_info(library_items)")
        .all()
        .map(({ name }) => name),
    ).not.toContain("trashed_at");
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

    expect(schemaVersion()).toBe(10);
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

  it("treats reopening v10 as a no-op", async () => {
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

  it("backs up and migrates schema v8 before adding custom metadata", async () => {
    const initializer = createStore();
    expect(await initializer.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await initializer.add({ item })).toEqual({ ok: true, value: item });
    initializer.close();
    using downgrade = new Database(databasePath, { strict: true });
    downgrade.transaction(() => {
      downgrade.run("DROP INDEX library_adoptions_by_state");
      downgrade.run("DROP TABLE library_adoptions");
      downgrade.run("DROP TABLE library_item_custom_metadata");
      downgrade.run("PRAGMA user_version = 8");
    }).immediate();
    downgrade.close();
    const before = await readFile(databasePath);

    const migrated = createStore();
    expect(await migrated.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await migrated.get({ id: item.id })).toEqual({ ok: true, value: item });
    migrated.close();

    expect(await readFile(`${databasePath}.v8.backup`)).toEqual(before);
    expect(schemaVersion()).toBe(10);
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

  it("preserves tag links when shared metadata omits tags and clears them when requested", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.add({ item: richItem })).toEqual({ ok: true, value: richItem });
    using database = new Database(databasePath, { strict: true });
    database.run(`
      CREATE TRIGGER reject_unrequested_tag_rewrite
      BEFORE DELETE ON library_item_tags
      WHEN OLD.library_item_id = '${richItem.id}'
      BEGIN
        SELECT RAISE(ABORT, 'metadata-only updates must preserve tag links');
      END
    `);

    expect(
      await store.update({
        id: richItem.id,
        patch: { series: "Ekumen", publisher: "Tor Books" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        series: "Ekumen",
        publisher: "Tor Books",
        tags: richItem.tags,
      },
    });

    database.run("DROP TRIGGER reject_unrequested_tag_rewrite");
    expect(await store.update({ id: richItem.id, patch: { tags: [] } })).toMatchObject({
      ok: true,
      value: { tags: [] },
    });
    expect(database.query("SELECT * FROM library_item_tags").all()).toEqual([]);
    expect(database.query("SELECT * FROM tags").all()).toEqual([]);
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
        customMetadata: { acquisition_source: "  City Books  ", shelf: "Utopias" },
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
        customMetadata: { acquisition_source: "  City Books  ", shelf: "Utopias" },
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
    expect(await first.search({ query: "Utopias" })).toEqual({
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
        .query("SELECT name, value FROM library_item_custom_metadata ORDER BY name")
        .all(),
    ).toEqual([
      { name: "acquisition_source", value: "  City Books  " },
      { name: "shelf", value: "Utopias" },
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
    expect(await store.update({ id: richItem.id, patch: {} })).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
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

  it("keeps trash transitions idempotent, discoverable, and excluded from active reads", async () => {
    const first = createStore();
    expect(await first.listTrash({ page: { offset: 0, limit: 10 } })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    await first.open({ config: {} });
    await first.add({ item: richItem });
    await first.add({ item: secondItem });

    expect(await first.trash({ id: richItem.id })).toEqual({ ok: true, value: richItem });
    using database = new Database(databasePath, { strict: true });
    const firstTimestamp = database
      .query<{ trashedAt: string }, [string]>(
        "SELECT trashed_at AS trashedAt FROM library_items WHERE id = ?",
      )
      .get(richItem.id)?.trashedAt;
    expect(firstTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await first.trash({ id: richItem.id })).toEqual({ ok: true, value: richItem });
    expect(
      database
        .query<{ trashedAt: string }, [string]>(
          "SELECT trashed_at AS trashedAt FROM library_items WHERE id = ?",
        )
        .get(richItem.id)?.trashedAt,
    ).toBe(firstTimestamp);
    expect(await first.add({ item: richItem })).toEqual({
      ok: false,
      error: { code: "duplicate-id" },
    });
    expect(await first.get({ id: richItem.id })).toEqual({ ok: true, value: richItem });
    expect(await first.list({})).toEqual({ ok: true, value: [secondItem] });
    expect(await first.search({ query: "Le Guin" })).toEqual({ ok: true, value: [] });
    expect(
      await first.query({
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
        page: { offset: 0, limit: 10 },
      }),
    ).toEqual({
      ok: true,
      value: {
        items: [secondItem],
        total: 1,
        page: { offset: 0, limit: 10 },
        facets: {
          authors: [],
          tags: [],
          series: [],
          languages: [],
          formats: [{ value: "epub", count: 1 }],
        },
      },
    });
    expect(await first.listTrash({ page: { offset: 0, limit: 10 } })).toEqual({
      ok: true,
      value: { items: [richItem], total: 1, page: { offset: 0, limit: 10 } },
    });
    first.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.listTrash({ page: { offset: 0, limit: 10 } })).toMatchObject({
      ok: true,
      value: { items: [{ id: richItem.id }], total: 1 },
    });
    expect(await reopened.restore({ id: richItem.id })).toEqual({ ok: true, value: richItem });
    expect(await reopened.restore({ id: richItem.id })).toEqual({ ok: true, value: richItem });
    expect(await reopened.listTrash({ page: { offset: 0, limit: 10 } })).toEqual({
      ok: true,
      value: { items: [], total: 0, page: { offset: 0, limit: 10 } },
    });
    expect(await reopened.search({ query: "Le Guin" })).toEqual({ ok: true, value: [richItem] });
  });

  it("pages trash newest-first with a stable id tie-break", async () => {
    const store = createStore();
    await store.open({ config: {} });
    const fixtures = [
      { ...item, id: "trash-z", title: "Z" },
      { ...item, id: "trash-a", title: "A" },
      { ...item, id: "trash-new", title: "Newest" },
    ];
    for (const fixture of fixtures) {
      await store.add({ item: fixture });
      await store.trash({ id: fixture.id });
    }
    using database = new Database(databasePath, { strict: true });
    database.run(
      "UPDATE library_items SET trashed_at = '2026-07-19T10:00:00.000Z' WHERE id IN ('trash-a', 'trash-z')",
    );
    database.run(
      "UPDATE library_items SET trashed_at = '2026-07-20T10:00:00.000Z' WHERE id = 'trash-new'",
    );

    expect(await store.listTrash({ page: { offset: 0, limit: 2 } })).toMatchObject({
      ok: true,
      value: {
        items: [{ id: "trash-new" }, { id: "trash-a" }],
        total: 3,
        page: { offset: 0, limit: 2 },
      },
    });
    expect(await store.listTrash({ page: { offset: 2, limit: 2 } })).toMatchObject({
      ok: true,
      value: {
        items: [{ id: "trash-z" }],
        total: 3,
        page: { offset: 2, limit: 2 },
      },
    });
  });

  it("rejects invalid trash requests and malformed stored trash timestamps", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    expect(await store.listTrash({ page: { offset: 0, limit: 101 } })).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await store.trash({ id: "" })).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await store.restore({ id: item.id, extra: true } as never)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await store.purge({ id: item.id, extra: true } as never)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });

    using database = new Database(databasePath, { strict: true });
    database.run("UPDATE library_items SET trashed_at = 'not-a-date' WHERE id = ?", [item.id]);
    expect(await store.listTrash({ page: { offset: 0, limit: 10 } })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await store.trash({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await store.restore({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await store.purge({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
  });

  it("purges only trashed items and makes successful purges idempotent", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    expect(await store.purge({ id: item.id })).toEqual({
      ok: false,
      error: { code: "not-trashed" },
    });
    expect(await store.purge({ id: "missing" })).toEqual({
      ok: true,
      value: { item: null, cleanupPending: false },
    });

    await store.trash({ id: item.id });
    expect(await store.purge({ id: item.id })).toEqual({
      ok: true,
      value: { item, cleanupPending: false },
    });
    expect(await store.purge({ id: item.id })).toEqual({
      ok: true,
      value: { item: null, cleanupPending: false },
    });
    expect(await store.get({ id: item.id })).toEqual({ ok: true, value: null });
  });

  it("persists failed managed cleanup after purge and retries it on reopen", async () => {
    const sourcePath = join(directory, "managed-trash.epub");
    await writeFile(sourcePath, "managed trash");
    const first = createStore();
    await first.open({ config: {} });
    const imported = await first.import({ sourcePath });
    if (!imported.ok) {
      throw new Error("Expected a managed import");
    }
    const managedPath = imported.value.sourcePath;
    await first.trash({ id: imported.value.id });
    lifecycleTestSeam.beforeManagedFileCleanup = (path) => {
      if (path === managedPath) {
        throw new Error("injected purge cleanup failure");
      }
    };

    expect(await first.purge({ id: imported.value.id })).toEqual({
      ok: true,
      value: { item: imported.value, cleanupPending: true },
    });
    expect(await Bun.file(managedPath).exists()).toBe(true);
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT source_path, kind FROM managed_file_cleanup").all()).toEqual([
      { source_path: basename(managedPath), kind: "format" },
    ]);

    delete lifecycleTestSeam.beforeManagedFileCleanup;
    first.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await Bun.file(managedPath).exists()).toBe(false);
    expect(database.query("SELECT * FROM managed_file_cleanup").all()).toEqual([]);
  });

  it("rolls purge metadata and cleanup handoff back together on interruption", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item });
    await store.trash({ id: item.id });
    lifecycleTestSeam.duringManagedItemRemoval = () => {
      throw new Error("injected purge interruption");
    };

    expect(await store.purge({ id: item.id })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    delete lifecycleTestSeam.duringManagedItemRemoval;
    expect(await store.listTrash({ page: { offset: 0, limit: 10 } })).toEqual({
      ok: true,
      value: { items: [item], total: 1, page: { offset: 0, limit: 10 } },
    });
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM managed_file_cleanup").all()).toEqual([]);
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
    ).toBe(10);
    expect(
      initializedDatabase
        .query<{ name: string; type: string }, []>(
          `SELECT name, type FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
            ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "duplicate_pair_reviews", type: "table" },
      { name: "library_adoptions", type: "table" },
      { name: "library_item_authors", type: "table" },
      { name: "library_item_custom_metadata", type: "table" },
      { name: "library_item_formats", type: "table" },
      { name: "library_item_identifiers", type: "table" },
      { name: "library_item_languages", type: "table" },
      { name: "library_item_tags", type: "table" },
      { name: "library_items", type: "table" },
      { name: "managed_file_cleanup", type: "table" },
      { name: "saved_library_views", type: "table" },
      { name: "source_file_cleanup", type: "table" },
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
