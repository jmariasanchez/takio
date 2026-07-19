import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { initializationTestSeam } from "../src/initialization-test-seam.js";
import { BunSqliteLibraryStore } from "../src/index.js";

const item: LibraryItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  tags: [],
};

const secondItem: LibraryItem = {
  id: "book-2",
  title: "Kindred",
  sourcePath: "library/kindred.epub",
  format: "epub",
  addedAt: "2026-07-18T13:00:00.000Z",
  tags: [],
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
  it("persists add, get, list, and remove across injected-path reopenings at schema v3", async () => {
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item })).toEqual({ ok: true, value: item });
    first.close();

    expect(schemaVersion()).toBe(3);
    using stored = new Database(databasePath, { strict: true });
    expect(
      stored
        .query<
          { libraryItemId: string; sourcePath: string; format: string; addedAt: string; position: number },
          []
        >(`
          SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
            format, added_at AS addedAt, position
          FROM library_item_formats
        `)
        .all(),
    ).toEqual([
      {
        libraryItemId: item.id,
        sourcePath: item.sourcePath,
        format: item.format,
        addedAt: item.addedAt,
        position: 0,
      },
    ]);

    const second = createStore();
    expect(await second.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await second.get({ id: item.id })).toEqual({ ok: true, value: item });
    expect(await second.list({})).toEqual({ ok: true, value: [item] });
    expect(await second.remove({ id: item.id })).toEqual({ ok: true, value: item });
    second.close();

    const third = createStore();
    expect(await third.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await third.get({ id: item.id })).toEqual({ ok: true, value: null });
    expect(await third.list({})).toEqual({ ok: true, value: [] });
    third.close();

    expect(schemaVersion()).toBe(3);
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
          tags: [],
        },
        {
          id: "book-v2-complete",
          title: "The Dispossessed",
          sourcePath: "library/the-dispossessed.epub",
          format: "epub",
          addedAt: "2026-07-17T10:15:00.000Z",
          author: "Ursula K. Le Guin",
          description: "An ambiguous utopia.",
          coverPath: join(directory, "covers", "the-dispossessed.png"),
          tags: ["Science Fiction", "Classic"],
          updatedAt: "2026-07-18T09:30:00.000Z",
        },
      ],
    });
    store.close();

    expect(schemaVersion()).toBe(3);
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

  it("backs up and migrates a frozen v1 library without changing original fields", async () => {
    createFrozenV1Fixture();

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toEqual({ ok: true, value: [secondItem, item] });
    store.close();

    expect(schemaVersion()).toBe(3);
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

  it("treats reopening v3 as a no-op", async () => {
    createFrozenV1Fixture();
    const first = createStore();
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    first.close();
    const backupBefore = await readFile(`${databasePath}.v1.backup`);
    const databaseBefore = await readFile(databasePath);

    const second = createStore();
    expect(await second.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await second.list({})).toEqual({ ok: true, value: [secondItem, item] });
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

  it("rolls scalar and tag changes back together when tag replacement fails", async () => {
    const store = createStore();
    await store.open({ config: {} });
    await store.add({ item: { ...item, author: "Original", tags: ["Classic"] } });
    const before = await store.get({ id: item.id });

    using database = new Database(databasePath);
    database.run(`
      CREATE TRIGGER reject_tag_replacement
      BEFORE INSERT ON library_item_tags
      BEGIN
        SELECT RAISE(ABORT, 'injected tag failure');
      END
    `);
    expect(
      await store.update({
        id: item.id,
        patch: { author: "Changed", tags: ["New"] },
      }),
    ).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(await store.get({ id: item.id })).toEqual(before);
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
    expect(await owner.remove({ id: item.id })).toMatchObject({ ok: true, value: { id: item.id } });
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
        (library_item_id, format, source_path, added_at, position) VALUES (?, ?, ?, ?, 0)`,
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
        (library_item_id, format, source_path, added_at, position) VALUES (?, 'pdf', ?, 'not-a-date', 1)`,
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
    ).toBe(3);
    expect(
      initializedDatabase
        .query<{ name: string; type: string }, []>(
          "SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "library_item_formats", type: "table" },
      { name: "library_item_tags", type: "table" },
      { name: "library_items", type: "table" },
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

  it("requires the caller to inject a database path", () => {
    expect(() => new BunSqliteLibraryStore("")).toThrow("A database path is required.");
  });
});
