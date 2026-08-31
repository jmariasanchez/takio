import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";
import { lifecycleTestSeam } from "../src/lifecycle-test-seam.js";

describe("BunSqliteLibraryStore recursive import", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-import-"));
    databasePath = join(directory, "library.sqlite");
    stores = [];
  });

  afterEach(async () => {
    delete lifecycleTestSeam.afterManagedFileInstalled;
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

  it("visits roots and descendants deterministically without following links or hiding duplicates", async () => {
    const store = await openStore();
    const existingPath = join(directory, "existing.epub");
    await writeFile(existingPath, "already managed");
    const existing = await store.import({ sourcePath: existingPath });
    if (!existing.ok) {
      throw new Error("Expected the existing managed import to succeed");
    }
    expect(await store.trash({ id: existing.value.id })).toEqual({
      ok: true,
      value: existing.value,
    });

    const root = join(directory, "root");
    const nested = join(root, "b");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "A.pdf"), "first content");
    await writeFile(join(nested, "0.mobi"), "nested content");
    await writeFile(join(nested, "z.epub"), "first content");
    await writeFile(join(root, "c.jpg"), "unsupported");
    await symlink(join(root, "A.pdf"), join(root, "link.epub"));
    const missing = join(directory, "missing");

    const result = await store.importMany({
      roots: [missing, root, root, existingPath, existingPath],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.counts).toEqual({
      total: 13,
      imported: 2,
      skipped: 4,
      duplicates: 6,
      failed: 1,
    });
    expect(
      result.value.outcomes.map((outcome) => ({
        status: outcome.status,
        sourcePath: outcome.sourcePath,
        detail:
          outcome.status === "skipped"
            ? outcome.reason
            : outcome.status === "duplicate"
              ? outcome.reason
              : outcome.status === "failed"
                ? outcome.code
                : outcome.item.title,
      })),
    ).toEqual([
      { status: "failed", sourcePath: missing, detail: "not-found" },
      { status: "imported", sourcePath: join(root, "A.pdf"), detail: "A" },
      { status: "imported", sourcePath: join(nested, "0.mobi"), detail: "0" },
      {
        status: "duplicate",
        sourcePath: join(nested, "z.epub"),
        detail: "earlier-in-request",
      },
      { status: "skipped", sourcePath: join(root, "c.jpg"), detail: "unsupported-format" },
      { status: "skipped", sourcePath: join(root, "link.epub"), detail: "symbolic-link" },
      {
        status: "duplicate",
        sourcePath: join(root, "A.pdf"),
        detail: "earlier-in-request",
      },
      {
        status: "duplicate",
        sourcePath: join(nested, "0.mobi"),
        detail: "earlier-in-request",
      },
      {
        status: "duplicate",
        sourcePath: join(nested, "z.epub"),
        detail: "earlier-in-request",
      },
      { status: "skipped", sourcePath: join(root, "c.jpg"), detail: "unsupported-format" },
      { status: "skipped", sourcePath: join(root, "link.epub"), detail: "symbolic-link" },
      { status: "duplicate", sourcePath: existingPath, detail: "existing-library" },
      { status: "duplicate", sourcePath: existingPath, detail: "earlier-in-request" },
    ]);

    const libraryDuplicate = result.value.outcomes[11];
    const requestDuplicate = result.value.outcomes[12];
    expect(libraryDuplicate).toMatchObject({
      existing: { itemId: existing.value.id, format: "epub" },
    });
    expect(requestDuplicate).toMatchObject({
      existing: { itemId: existing.value.id, format: "epub" },
    });
  });

  it("keeps entry failures atomic while later files continue importing", async () => {
    const store = await openStore();
    const firstPath = join(directory, "first.epub");
    const secondPath = join(directory, "second.pdf");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    let installations = 0;
    lifecycleTestSeam.afterManagedFileInstalled = () => {
      installations += 1;
      if (installations === 1) {
        throw new Error("injected installation failure");
      }
    };

    const result = await store.importMany({ roots: [firstPath, secondPath] });
    expect(result).toMatchObject({
      ok: true,
      value: {
        counts: { total: 2, imported: 1, skipped: 0, duplicates: 0, failed: 1 },
        outcomes: [
          { status: "failed", sourcePath: firstPath, code: "storage-unavailable" },
          { status: "imported", sourcePath: secondPath, item: { title: "second" } },
        ],
      },
    });
    expect(await store.list({})).toMatchObject({ ok: true, value: [{ title: "second" }] });
    expect(readdir(join(directory, "items"))).resolves.toHaveLength(1);
  });

  it("ignores macOS AppleDouble files that retain ebook extensions", async () => {
    const store = await openStore();
    const root = join(directory, "kindle");
    await mkdir(root);
    await writeFile(join(root, "._book.mobi"), "finder metadata");
    await writeFile(join(root, "book.mobi"), "book contents");

    const result = await store.importMany({ roots: [root] });

    expect(result).toMatchObject({
      ok: true,
      value: {
        counts: { total: 2, imported: 1, skipped: 1, duplicates: 0, failed: 0 },
        outcomes: [
          { status: "skipped", sourcePath: join(root, "._book.mobi"), reason: "unsupported-format" },
          { status: "imported", sourcePath: join(root, "book.mobi") },
        ],
      },
    });
  });

  it("organizes recursively imported files into managed storage", async () => {
    const store = await openStore();
    const root = join(directory, "organize");
    await mkdir(root);
    const epubPath = join(root, "first.epub");
    const pdfPath = join(root, "second.pdf");
    await writeFile(epubPath, "first organized contents");
    await writeFile(pdfPath, "second organized contents");

    const result = await store.importMany({ roots: [root], mode: "move" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        counts: { total: 2, imported: 2, skipped: 0, duplicates: 0, failed: 0 },
        outcomes: [
          { status: "imported", sourcePath: epubPath, sourceCleanupPending: false },
          { status: "imported", sourcePath: pdfPath, sourceCleanupPending: false },
        ],
      },
    });
    expect(await Bun.file(epubPath).exists()).toBe(false);
    expect(await Bun.file(pdfPath).exists()).toBe(false);
    expect(await readdir(join(directory, "items"))).toHaveLength(2);
  });

  it("rejects malformed requests at the outer result boundary", async () => {
    const store = await openStore();
    for (const request of [{ roots: [] }, { roots: ["   "] }, { roots: [directory], extra: true }]) {
      expect(await store.importMany(request as { roots: string[] })).toEqual({
        ok: false,
        error: { code: "invalid-arguments" },
      });
    }
  });
});

describe("BunSqliteLibraryStore schema-v7 fingerprints", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-v7-"));
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

  function downgradeFormatsToV6(): void {
    using database = new Database(databasePath, { strict: true });
    database.transaction(() => {
      database.run("DROP INDEX library_adoptions_by_state");
      database.run("DROP TABLE library_adoptions");
      database.run("DROP INDEX library_item_formats_by_fingerprint");
      database.run("DROP INDEX library_item_formats_by_format");
      database.run("DROP TABLE library_item_custom_metadata");
      database.run("DROP TABLE duplicate_pair_reviews");
      database.run("ALTER TABLE library_item_formats RENAME TO library_item_formats_v7");
      database.run(`
        CREATE TABLE library_item_formats (
          library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          format TEXT NOT NULL,
          source_path TEXT NOT NULL,
          added_at TEXT NOT NULL,
          provenance TEXT NOT NULL CHECK (provenance IN ('managed', 'referenced')),
          position INTEGER NOT NULL CHECK (position >= 0),
          PRIMARY KEY (library_item_id, format),
          UNIQUE (library_item_id, position)
        ) STRICT
      `);
      database.run(`
        INSERT INTO library_item_formats
          (library_item_id, format, source_path, added_at, provenance, position)
        SELECT library_item_id, format, source_path, added_at, provenance, position
        FROM library_item_formats_v7
      `);
      database.run("DROP TABLE library_item_formats_v7");
      database.run(`
        CREATE INDEX library_item_formats_by_format
        ON library_item_formats(format, library_item_id)
      `);
      database.run("PRAGMA user_version = 6");
    }).immediate();
  }

  async function createV6Library(): Promise<{ bytes: Uint8Array; item: LibraryItem }> {
    const sourcePath = join(directory, "managed.epub");
    const bytes = new TextEncoder().encode("managed migration content");
    await writeFile(sourcePath, bytes);
    const initializer = createStore();
    expect(await initializer.open({ config: {} })).toEqual({ ok: true, value: null });
    const referencedPath = join(directory, "referenced.pdf");
    const referencedItem: LibraryItem = {
      id: "referenced-v6",
      title: "Referenced",
      sourcePath: referencedPath,
      format: "pdf",
      addedAt: "2026-07-20T00:00:00.000Z",
      formats: [
        {
          sourcePath: referencedPath,
          format: "pdf",
          addedAt: "2026-07-20T00:00:00.000Z",
          provenance: "referenced",
        },
      ],
      tags: [],
    };
    expect(await initializer.add({ item: referencedItem })).toEqual({
      ok: true,
      value: referencedItem,
    });
    const imported = await initializer.import({ sourcePath });
    if (!imported.ok) {
      throw new Error("Expected managed import fixture to succeed");
    }
    initializer.close();
    downgradeFormatsToV6();
    return { bytes, item: imported.value };
  }

  it("backs up v6 and migrates exact managed fingerprints while leaving references null", async () => {
    const { bytes, item } = await createV6Library();
    const before = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    store.close();

    expect(await readFile(`${databasePath}.v6.backup`)).toEqual(before);
    using migrated = new Database(databasePath, { strict: true });
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 11,
    });
    expect(
      migrated
        .query<
          {
            libraryItemId: string;
            contentBytes: number | null;
            contentSha256: string | null;
          },
          []
        >(`
          SELECT library_item_id AS libraryItemId, content_bytes AS contentBytes,
            content_sha256 AS contentSha256
          FROM library_item_formats ORDER BY library_item_id
        `)
        .all(),
    ).toEqual([
      {
        libraryItemId: item.id,
        contentBytes: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
      },
      {
        libraryItemId: "referenced-v6",
        contentBytes: null,
        contentSha256: null,
      },
    ]);
  });

  it("rolls v6 back byte-for-byte when the fingerprint index cannot be created", async () => {
    await createV6Library();
    {
      using database = new Database(databasePath, { strict: true });
      database.run("CREATE TABLE migration_collision (id INTEGER PRIMARY KEY) STRICT");
      database.run(
        "CREATE INDEX library_item_formats_by_fingerprint ON migration_collision(id)",
      );
    }
    const before = await readFile(databasePath);

    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await readFile(databasePath)).toEqual(before);
    expect(await readFile(`${databasePath}.v6.backup`)).toEqual(before);
    using rolledBack = new Database(databasePath, { strict: true });
    expect(rolledBack.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
    expect(
      rolledBack
        .query<{ name: string }, []>("PRAGMA table_info(library_item_formats)")
        .all()
        .map(({ name }) => name),
    ).not.toContain("content_sha256");
  });
});
