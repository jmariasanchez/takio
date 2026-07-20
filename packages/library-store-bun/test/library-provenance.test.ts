import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializationTestSeam } from "../src/initialization-test-seam.js";
import { BunSqliteLibraryStore } from "../src/index.js";

type V3FormatTuple = {
  libraryItemId: string;
  format: string;
  sourcePath: string;
  addedAt: string;
  position: number;
};

type V4FormatTuple = V3FormatTuple & { provenance: string | null };

describe("BunSqliteLibraryStore schema-v4 provenance", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-provenance-"));
    databasePath = join(directory, "library.sqlite");
    stores = [];
  });

  afterEach(async () => {
    delete initializationTestSeam.duringV3ToV4Migration;

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

  async function createFrozenV3Fixture(): Promise<void> {
    const libraryRoot = directory.replaceAll("'", "''");
    const externalRoot = join(directory, "caller-owned").replaceAll("'", "''");
    const fixture = (await readFile(join(import.meta.dir, "fixtures", "schema-v3.sql"), "utf8"))
      .replaceAll("__LIBRARY_ROOT__", libraryRoot)
      .replaceAll("__EXTERNAL_ROOT__", externalRoot);
    using database = new Database(databasePath, { create: true, strict: true });
    database.exec(fixture);
  }

  function schemaVersion(path = databasePath): number | undefined {
    using database = new Database(path, { strict: true });
    return database.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version;
  }

  function formatColumns(path = databasePath): string[] {
    using database = new Database(path, { strict: true });
    return database
      .query<{ name: string }, []>("PRAGMA table_info(library_item_formats)")
      .all()
      .map(({ name }) => name);
  }

  function readV3FormatTuples(path = databasePath): V3FormatTuple[] {
    using database = new Database(path, { strict: true });
    return database
      .query<V3FormatTuple, []>(`
        SELECT library_item_id AS libraryItemId, format, source_path AS sourcePath,
          added_at AS addedAt, position
        FROM library_item_formats
        ORDER BY library_item_id, position
      `)
      .all();
  }

  function readV4FormatTuples(): V4FormatTuple[] {
    using database = new Database(databasePath, { strict: true });
    return database
      .query<V4FormatTuple, []>(`
        SELECT library_item_id AS libraryItemId, format, source_path AS sourcePath,
          added_at AS addedAt, position, provenance
        FROM library_item_formats
        ORDER BY library_item_id, position
      `)
      .all();
  }

  it("backs up and migrates a frozen v3 library without inventing file ownership", async () => {
    await createFrozenV3Fixture();
    const beforeTuples = readV3FormatTuples();
    const databaseBefore = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.list({})).toEqual({
      ok: true,
      value: [
        {
          id: "book-v3-singleton",
          title: "A Wizard of Earthsea",
          sourcePath: join(directory, "items", "book-v3-singleton.epub"),
          format: "epub",
          addedAt: "2026-07-14T08:00:00.000Z",
          formats: [
            {
              sourcePath: join(directory, "items", "book-v3-singleton.epub"),
              format: "epub",
              addedAt: "2026-07-14T08:05:00.000Z",
              provenance: "referenced",
            },
          ],
          author: "Ursula K. Le Guin",
          tags: ["Fantasy"],
        },
        {
          id: "book-v3-multi",
          title: "The Fifth Season",
          sourcePath: join(directory, "caller-owned", "the-fifth-season.epub"),
          format: "epub",
          addedAt: "2026-07-15T09:30:00.000Z",
          formats: [
            {
              sourcePath: join(directory, "caller-owned", "the-fifth-season.epub"),
              format: "epub",
              addedAt: "2026-07-15T09:35:00.000Z",
              provenance: "referenced",
            },
            {
              sourcePath: join(directory, "items", "book-v3-multi.pdf"),
              format: "pdf",
              addedAt: "2026-07-16T11:20:00.000Z",
              provenance: "referenced",
            },
          ],
          author: "N. K. Jemisin",
          description: "The first Broken Earth novel.",
          coverPath: join(directory, "covers", "the-fifth-season.png"),
          tags: ["Fantasy", "Hugo Winner"],
          updatedAt: "2026-07-18T17:45:00.000Z",
        },
      ],
    });
    store.close();

    const backupPath = `${databasePath}.v3.backup`;
    expect(schemaVersion()).toBe(8);
    expect(await readFile(backupPath)).toEqual(databaseBefore);
    expect(schemaVersion(backupPath)).toBe(3);
    expect(formatColumns(backupPath)).not.toContain("provenance");
    expect(readV3FormatTuples(backupPath)).toEqual(beforeTuples);

    const migratedTuples = readV4FormatTuples();
    expect(migratedTuples.map(({ provenance: _provenance, ...tuple }) => tuple)).toEqual(
      beforeTuples,
    );
    expect(migratedTuples.every(({ provenance }) => provenance === "referenced")).toBe(true);
    expect(
      migratedTuples
        .filter(({ sourcePath }) => sourcePath.startsWith(join(directory, "items")))
        .map(({ provenance }) => provenance),
    ).toEqual(["referenced", "referenced"]);

    const databaseAfterMigration = await readFile(databasePath);
    const backupAfterMigration = await readFile(backupPath);
    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.get({ id: "book-v3-multi" })).toMatchObject({
      ok: true,
      value: {
        formats: [
          { format: "epub", provenance: "referenced" },
          { format: "pdf", provenance: "referenced" },
        ],
      },
    });
    reopened.close();

    expect(await readFile(databasePath)).toEqual(databaseAfterMigration);
    expect(await readFile(backupPath)).toEqual(backupAfterMigration);
  });

  it("rejects current rows whose provenance is missing or outside the v4 enum", async () => {
    const initializer = createStore();
    expect(await initializer.open({ config: {} })).toEqual({ ok: true, value: null });
    initializer.close();

    using database = new Database(databasePath, { strict: true });
    database.run("PRAGMA foreign_keys = OFF");
    database.transaction(() => {
      database.run("ALTER TABLE library_item_formats RENAME TO valid_library_item_formats");
      database.run(`
        CREATE TABLE library_item_formats (
          library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          format TEXT NOT NULL,
          source_path TEXT NOT NULL,
          added_at TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          provenance TEXT,
          PRIMARY KEY (library_item_id, format),
          UNIQUE (library_item_id, position)
        ) STRICT
      `);
      database.run(
        "INSERT INTO library_items (id, title, added_at) VALUES (?, ?, ?), (?, ?, ?)",
        [
          "missing-provenance",
          "Missing provenance",
          "2026-07-19T09:00:00.000Z",
          "invalid-provenance",
          "Invalid provenance",
          "2026-07-19T10:00:00.000Z",
        ],
      );
      database.run(
        `INSERT INTO library_item_formats
          (library_item_id, format, source_path, added_at, position, provenance)
          VALUES (?, 'epub', ?, ?, 0, NULL), (?, 'pdf', ?, ?, 0, 'borrowed')`,
        [
          "missing-provenance",
          join(directory, "missing.epub"),
          "2026-07-19T09:00:00.000Z",
          "invalid-provenance",
          join(directory, "invalid.pdf"),
          "2026-07-19T10:00:00.000Z",
        ],
      );
      database.run("DROP TABLE valid_library_item_formats");
    }).immediate();
    database.close();
    const databaseBeforeReads = await readFile(databasePath);

    const reader = createStore();
    expect(await reader.open({ config: {} })).toEqual({ ok: true, value: null });
    for (const id of ["missing-provenance", "invalid-provenance"]) {
      expect(await reader.get({ id })).toEqual({
        ok: false,
        error: { code: "invalid-stored-data" },
      });
    }
    expect(await reader.list({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
    reader.close();

    expect(await readFile(databasePath)).toEqual(databaseBeforeReads);
  });

  it("rolls a v3 library back byte-for-byte when v4 migration is interrupted", async () => {
    await createFrozenV3Fixture();
    const databaseBefore = await readFile(databasePath);
    const tuplesBefore = readV3FormatTuples();
    initializationTestSeam.duringV3ToV4Migration = () => {
      throw new Error("injected v3-to-v4 migration failure");
    };

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    expect(await readFile(databasePath)).toEqual(databaseBefore);
    expect(await readFile(`${databasePath}.v3.backup`)).toEqual(databaseBefore);
    expect(schemaVersion()).toBe(3);
    expect(formatColumns()).not.toContain("provenance");
    expect(readV3FormatTuples()).toEqual(tuplesBefore);
  });
});
