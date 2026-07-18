import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";

const item: LibraryItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
};

let directory: string;
let databasePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "takio-library-store-bun-"));
  databasePath = join(directory, "library.sqlite");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function schemaVersion(): number | undefined {
  using database = new Database(databasePath);
  return database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
}

describe("BunSqliteLibraryStore", () => {
  it("persists add, get, list, and remove across injected-path reopenings at schema v1", async () => {
    const first = new BunSqliteLibraryStore(databasePath);
    expect(await first.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await first.add({ item })).toEqual({ ok: true, value: item });
    first.close();

    expect(schemaVersion()).toBe(1);

    const second = new BunSqliteLibraryStore(databasePath);
    expect(await second.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await second.get({ id: item.id })).toEqual({ ok: true, value: item });
    expect(await second.list({})).toEqual({ ok: true, value: [item] });
    expect(await second.remove({ id: item.id })).toEqual({ ok: true, value: item });
    second.close();

    const third = new BunSqliteLibraryStore(databasePath);
    expect(await third.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await third.get({ id: item.id })).toEqual({ ok: true, value: null });
    expect(await third.list({})).toEqual({ ok: true, value: [] });
    third.close();

    expect(schemaVersion()).toBe(1);
  });

  it("maps duplicate primary keys to the contract error", async () => {
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });

    expect(await store.add({ item })).toEqual({ ok: true, value: item });
    expect(await store.add({ item })).toEqual({ ok: false, error: { code: "duplicate-id" } });
    store.close();
  });

  it("revalidates rows read from durable storage", async () => {
    const store = new BunSqliteLibraryStore(databasePath);
    await store.open({ config: {} });
    store.close();

    using database = new Database(databasePath);
    database.run(
      `INSERT INTO library_items (id, title, source_path, format, added_at) VALUES (?, ?, ?, ?, ?)`,
      [item.id, item.title, item.sourcePath, "invalid-format", item.addedAt],
    );

    const reopened = new BunSqliteLibraryStore(databasePath);
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: item.id })).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    expect(await reopened.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    reopened.close();
  });

  it("rejects schemas other than v1", async () => {
    using database = new Database(databasePath);
    database.run("PRAGMA user_version = 2");
    database.close();

    const store = new BunSqliteLibraryStore(databasePath);
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "incompatible-schema" },
    });
  });

  it("requires the caller to inject a database path", () => {
    expect(() => new BunSqliteLibraryStore("")).toThrow("A database path is required.");
  });
});
