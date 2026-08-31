import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore, LIBRARY_SCHEMA_VERSION } from "../src/index.js";

let directory: string;
let databasePath: string;
let stores: BunSqliteLibraryStore[];

const item: LibraryItem = {
  id: "book-1",
  title: "Kindred",
  sourcePath: "library/kindred.epub",
  format: "epub",
  addedAt: "2026-08-31T12:00:00.000Z",
  formats: [
    {
      sourcePath: "library/kindred.epub",
      format: "epub",
      addedAt: "2026-08-31T12:00:00.000Z",
      provenance: "referenced",
    },
  ],
  customMetadata: {
    shelf: "Favorites",
    undeclared_legacy: "keep me",
    takio_metadata_audit: "{\"source\":\"bounded audit\"}",
  },
  tags: [],
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "takio-library-text-columns-"));
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

describe("library-defined text columns", () => {
  it("creates, lists, renames, reopens, removes, and preserves every per-book value", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.add({ item })).toEqual({ ok: true, value: item });

    expect(await store.createTextColumnDefinition({ key: "shelf", label: "Shelf" })).toEqual({
      ok: true,
      value: { key: "shelf", label: "Shelf", type: "text", position: 0 },
    });
    expect(await store.createTextColumnDefinition({ key: "source", label: "Shelf" })).toEqual({
      ok: true,
      value: { key: "source", label: "Shelf", type: "text", position: 1 },
    });
    expect(await store.renameTextColumnDefinition({ key: "shelf", label: " Favorites " })).toEqual({
      ok: true,
      value: { key: "shelf", label: "Favorites", type: "text", position: 0 },
    });
    expect(await store.renameTextColumnDefinition({ key: "missing", label: "Missing" })).toEqual({
      ok: false,
      error: { code: "not-found" },
    });

    store.close();
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.listTextColumnDefinitions({})).toEqual({
      ok: true,
      value: [
        { key: "shelf", label: "Favorites", type: "text", position: 0 },
        { key: "source", label: "Shelf", type: "text", position: 1 },
      ],
    });
    expect(await reopened.removeTextColumnDefinition({ key: "shelf" })).toEqual({
      ok: true,
      value: { key: "shelf", label: "Favorites", type: "text", position: 0 },
    });
    expect(await reopened.listTextColumnDefinitions({})).toEqual({
      ok: true,
      value: [{ key: "source", label: "Shelf", type: "text", position: 0 }],
    });
    expect(await reopened.get({ id: item.id })).toEqual({ ok: true, value: item });
  });

  it("rejects invalid, reserved, duplicate, and over-limit definitions before mutation", async () => {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    for (const request of [
      { key: "Bad Key", label: "Bad" },
      { key: "takio_metadata_audit", label: "Audit" },
      { key: "blank", label: " " },
      { key: "long", label: "x".repeat(121) },
    ]) {
      expect(await store.createTextColumnDefinition(request)).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
    }
    expect(await store.listTextColumnDefinitions({})).toEqual({ ok: true, value: [] });

    for (let index = 0; index < 64; index += 1) {
      expect(await store.createTextColumnDefinition({ key: `field_${index}`, label: "Field" })).toMatchObject({
        ok: true,
        value: { position: index },
      });
    }
    expect(await store.createTextColumnDefinition({ key: "field_0", label: "Duplicate" })).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await store.createTextColumnDefinition({ key: "overflow", label: "Overflow" })).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    const listed = await store.listTextColumnDefinitions({});
    expect(listed.ok && listed.value).toHaveLength(64);
  });

  it("migrates v10 with an empty definition table while retaining custom metadata and audit bytes", async () => {
    const original = createStore();
    expect(await original.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await original.add({ item })).toEqual({ ok: true, value: item });
    original.close();

    using legacy = new Database(databasePath, { strict: true });
    const beforeRows = legacy
      .query("SELECT library_item_id, name, value FROM library_item_custom_metadata ORDER BY name")
      .all();
    legacy.run("DROP TABLE library_custom_column_definitions");
    legacy.run("PRAGMA user_version = 10");
    legacy.close();
    const before = await readFile(databasePath);

    const migrated = createStore();
    expect(await migrated.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await migrated.listTextColumnDefinitions({})).toEqual({ ok: true, value: [] });
    expect(await migrated.get({ id: item.id })).toEqual({ ok: true, value: item });
    using current = new Database(databasePath, { strict: true });
    expect(current.query("PRAGMA user_version").get()).toEqual({ user_version: LIBRARY_SCHEMA_VERSION });
    expect(
      current.query("SELECT library_item_id, name, value FROM library_item_custom_metadata ORDER BY name").all(),
    ).toEqual(beforeRows);
    expect(await readFile(`${databasePath}.v10.backup`)).toEqual(before);
  });

  it("backs up and migrates a pre-feature v11 database without changing metadata bytes", async () => {
    const original = createStore();
    expect(await original.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await original.add({ item })).toEqual({ ok: true, value: item });
    original.close();

    using legacy = new Database(databasePath, { strict: true });
    const beforeRows = legacy
      .query("SELECT library_item_id, name, value FROM library_item_custom_metadata ORDER BY name")
      .all();
    legacy.run("DROP TABLE library_custom_column_definitions");
    legacy.run("PRAGMA user_version = 11");
    legacy.close();
    const before = await readFile(databasePath);

    const migrated = createStore();
    expect(await migrated.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await migrated.listTextColumnDefinitions({})).toEqual({ ok: true, value: [] });
    expect(await migrated.get({ id: item.id })).toEqual({ ok: true, value: item });
    migrated.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: item.id })).toEqual({ ok: true, value: item });
    using current = new Database(databasePath, { strict: true });
    expect(current.query("PRAGMA user_version").get()).toEqual({ user_version: 12 });
    expect(
      current.query("SELECT library_item_id, name, value FROM library_item_custom_metadata ORDER BY name").all(),
    ).toEqual(beforeRows);
    expect(await readFile(`${databasePath}.v11.backup`)).toEqual(before);
  });

  it("migrates feature-v11 definitions and matches Rust's canonical table DDL", async () => {
    const original = createStore();
    expect(await original.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await original.createTextColumnDefinition({ key: "shelf", label: "Shelf" })).toMatchObject({
      ok: true,
    });
    original.close();

    using legacy = new Database(databasePath, { strict: true });
    const definitions = legacy
      .query("SELECT key,label,type,position FROM library_custom_column_definitions")
      .all();
    legacy.run("DROP TABLE library_custom_column_definitions");
    legacy.run(`CREATE TABLE library_text_column_definitions (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type = 'text'),
      position INTEGER NOT NULL UNIQUE
    ) STRICT`);
    for (const definition of definitions) {
      legacy.run(
        "INSERT INTO library_text_column_definitions (key,label,type,position) VALUES (?,?,?,?)",
        Object.values(definition),
      );
    }
    legacy.run("PRAGMA user_version = 11");
    legacy.close();

    const migrated = createStore();
    expect(await migrated.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await migrated.listTextColumnDefinitions({})).toEqual({
      ok: true,
      value: [{ key: "shelf", label: "Shelf", type: "text", position: 0 }],
    });
    using current = new Database(databasePath, { strict: true });
    const sql = current
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'library_custom_column_definitions'",
      )
      .get()?.sql;
    expect(sql?.replace(/\s+/g, "").toLowerCase()).toBe(
      `CREATE TABLE library_custom_column_definitions (
        key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
        label TEXT NOT NULL CHECK(length(label)>0),
        type TEXT NOT NULL CHECK(type='text'),
        position INTEGER NOT NULL UNIQUE CHECK(position>=0)
      ) STRICT`.replace(/\s+/g, "").toLowerCase(),
    );
  });
});
