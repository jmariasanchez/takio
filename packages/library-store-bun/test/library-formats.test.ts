import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";

const primaryFormat = {
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-17T12:00:00.000Z",
  provenance: "referenced",
} as const;
const secondaryFormat = {
  sourcePath: "library/left-hand.pdf",
  format: "pdf",
  addedAt: "2026-07-19T12:00:00.000Z",
  provenance: "referenced",
} as const;
const twoFormatItem: LibraryItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: primaryFormat.sourcePath,
  format: primaryFormat.format,
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [primaryFormat, secondaryFormat],
  tags: [],
};

describe("BunSqliteLibraryStore authoritative formats", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-formats-"));
    databasePath = join(directory, "library.sqlite");
    stores = [];
  });

  afterEach(async () => {
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

  async function initializeV4(): Promise<void> {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    store.close();
  }

  function expectNoLibraryRows(): void {
    using database = new Database(databasePath, { strict: true });
    expect(database.query("SELECT * FROM library_items").all()).toEqual([]);
    expect(database.query("SELECT * FROM library_item_formats").all()).toEqual([]);
    expect(database.query("SELECT * FROM library_item_tags").all()).toEqual([]);
    expect(database.query("SELECT * FROM tags").all()).toEqual([]);
  }

  it("reads a manual two-format v4 aggregate in position order across reopen", async () => {
    await initializeV4();
    using database = new Database(databasePath, { strict: true });
    database.run(
      "INSERT INTO library_items (id, title, added_at) VALUES (?, ?, ?)",
      [twoFormatItem.id, twoFormatItem.title, twoFormatItem.addedAt],
    );
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position)
        VALUES (?, ?, ?, ?, 'referenced', 0)`,
      [
        twoFormatItem.id,
        primaryFormat.format,
        primaryFormat.sourcePath,
        primaryFormat.addedAt,
      ],
    );
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position)
        VALUES (?, ?, ?, ?, 'referenced', 1)`,
      [
        twoFormatItem.id,
        secondaryFormat.format,
        secondaryFormat.sourcePath,
        secondaryFormat.addedAt,
      ],
    );
    database.close();

    const reader = createStore();
    expect(await reader.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reader.get({ id: twoFormatItem.id })).toEqual({
      ok: true,
      value: twoFormatItem,
    });
    reader.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.list({})).toEqual({ ok: true, value: [twoFormatItem] });
    expect(await reopened.search({ query: "left hand" })).toEqual({
      ok: true,
      value: [twoFormatItem],
    });
  });

  it("rejects a valid public two-format add before writing any rows", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });

    expect(await store.add({ item: twoFormatItem })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    store.close();

    expectNoLibraryRows();
  });

  it("rejects malformed, duplicate, and alias-mismatched public aggregates atomically", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    const singleFormatItem = { ...twoFormatItem, formats: [primaryFormat] };
    const invalidItems = [
      { ...singleFormatItem, formats: [{ ...primaryFormat, addedAt: "yesterday" }] },
      {
        ...twoFormatItem,
        formats: [primaryFormat, { ...primaryFormat, sourcePath: "library/copy.epub" }],
      },
      { ...singleFormatItem, sourcePath: "library/another.epub" },
      {
        ...singleFormatItem,
        format: "pdf",
      },
    ];

    for (const item of invalidItems) {
      expect(await store.add({ item: item as never })).toEqual({
        ok: false,
        error: { code: "invalid-stored-data" },
      });
    }
    store.close();

    expectNoLibraryRows();
  });

  it("does not search, update, or remove through a corrupt secondary format", async () => {
    const writer = createStore();
    expect(await writer.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(
      await writer.add({ item: { ...twoFormatItem, formats: [primaryFormat] } }),
    ).toMatchObject({ ok: true, value: { id: twoFormatItem.id } });
    writer.close();

    using database = new Database(databasePath, { strict: true });
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position)
        VALUES (?, 'pdf', ?, 'not-a-date', 'referenced', 1)`,
      [twoFormatItem.id, secondaryFormat.sourcePath],
    );
    database.close();

    const reader = createStore();
    expect(await reader.open({ config: {} })).toEqual({ ok: true, value: null });
    const invalidStoredData = {
      ok: false,
      error: { code: "invalid-stored-data" },
    } as const;
    expect(await reader.search({ query: "left hand" })).toEqual(invalidStoredData);
    expect(
      await reader.update({
        id: twoFormatItem.id,
        patch: { title: "Changed", tags: [] },
      }),
    ).toEqual(invalidStoredData);
    expect(await reader.remove({ id: twoFormatItem.id })).toEqual(invalidStoredData);
    reader.close();

    using unchanged = new Database(databasePath, { strict: true });
    expect(
      unchanged
        .query<{ title: string }, [string]>(
          "SELECT title FROM library_items WHERE id = ?",
        )
        .get(twoFormatItem.id),
    ).toEqual({ title: twoFormatItem.title });
    expect(
      unchanged
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM library_item_formats WHERE library_item_id = ?",
        )
        .get(twoFormatItem.id),
    ).toEqual({ count: 2 });
  });
});
