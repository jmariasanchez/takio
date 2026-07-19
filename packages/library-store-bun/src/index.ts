import { libraryItemSchema, type LibraryItem } from "@takio/core";
import type {
  AddLibraryItemRequest,
  AddLibraryItemResult,
  GetLibraryItemRequest,
  GetLibraryItemResult,
  LibraryStore,
  LibraryStoreErrorCode,
  LibraryStoreResult,
  ListLibraryItemsRequest,
  ListLibraryItemsResult,
  OpenLibraryRequest,
  OpenLibraryResult,
  RemoveLibraryItemRequest,
  RemoveLibraryItemResult,
} from "@takio/library-contract";
import { Database } from "bun:sqlite";
import { renameSync, rmSync, writeFileSync } from "node:fs";

import { initializationTestSeam } from "./initialization-test-seam.js";

const SCHEMA_VERSION = 2;
const incompatibleSchema = Symbol("incompatible-schema");

type StoredLibraryItem = {
  id: unknown;
  title: unknown;
  sourcePath: unknown;
  format: unknown;
  addedAt: unknown;
  author: unknown;
  description: unknown;
  coverPath: unknown;
  updatedAt: unknown;
};

type StoredV1LibraryItem = Pick<
  StoredLibraryItem,
  "id" | "title" | "sourcePath" | "format" | "addedAt"
>;
type StoredTag = { name: unknown };

const success = <T>(value: T): LibraryStoreResult<T> => ({ ok: true, value });
const failure = <T>(code: LibraryStoreErrorCode): LibraryStoreResult<T> => ({
  ok: false,
  error: { code },
});

function isDuplicateIdError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE")
  );
}

function readItem(
  database: Database,
  row: StoredLibraryItem,
): LibraryStoreResult<LibraryItem> {
  if (typeof row.id !== "string") {
    return failure("invalid-stored-data");
  }

  const tags = database
    .query<StoredTag, [string]>(`
      SELECT tags.name
      FROM library_item_tags
      JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
      WHERE library_item_tags.library_item_id = ?
      ORDER BY library_item_tags.position
    `)
    .all(row.id)
    .map(({ name }) => name);
  const parsed = libraryItemSchema.safeParse({
    ...row,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    coverPath: row.coverPath ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    tags,
  });
  return parsed.success ? success(parsed.data) : failure("invalid-stored-data");
}

function createMetadataTables(database: Database): void {
  database.run(`
    CREATE TABLE tags (
      normalized_name TEXT PRIMARY KEY,
      name TEXT NOT NULL
    ) STRICT
  `);
  database.run(`
    CREATE TABLE library_item_tags (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (library_item_id, tag_normalized_name),
      UNIQUE (library_item_id, position)
    ) STRICT
  `);
}

function verifyV1Backup(path: string): void {
  using backup = new Database(path, { strict: true });
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  const integrity = backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    ?.integrity_check;
  const rows = backup
    .query<StoredV1LibraryItem, []>(`
      SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt
      FROM library_items
      ORDER BY rowid
    `)
    .all();

  if (version !== 1 || integrity !== "ok" || !libraryItemSchema.array().safeParse(rows).success) {
    throw new Error("The pre-migration backup could not be verified.");
  }
}

function retainVerifiedV1Backup(database: Database, databasePath: string): void {
  const backupPath = `${databasePath}.v1.backup`;
  const temporaryPath = `${backupPath}.${crypto.randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, database.serialize());
    verifyV1Backup(temporaryPath);
    renameSync(temporaryPath, backupPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function verifyV2Database(database: Database): void {
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    ?.integrity_check;
  const rows = database
    .query<StoredLibraryItem, []>(`
      SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt,
        author, description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      ORDER BY rowid
    `)
    .all();

  if (integrity !== "ok" || rows.some((row) => !readItem(database, row).ok)) {
    throw new Error("The migrated database could not be verified.");
  }
}

function replaceTags(database: Database, item: LibraryItem): void {
  for (const [position, name] of item.tags.entries()) {
    const normalizedName = name.toLowerCase();
    database.run("INSERT OR IGNORE INTO tags (normalized_name, name) VALUES (?, ?)", [
      normalizedName,
      name,
    ]);
    database.run(
      `INSERT INTO library_item_tags
        (library_item_id, tag_normalized_name, position) VALUES (?, ?, ?)`,
      [item.id, normalizedName, position],
    );
  }
}

export class BunSqliteLibraryStore implements LibraryStore {
  readonly #databasePath: string;
  #database: Database | null = null;

  constructor(databasePath: string) {
    if (databasePath.length === 0) {
      throw new TypeError("A database path is required.");
    }

    this.#databasePath = databasePath;
  }

  async open(_request: OpenLibraryRequest): Promise<OpenLibraryResult> {
    if (this.#database) {
      return success(null);
    }

    let database: Database | null = null;

    try {
      database = new Database(this.#databasePath, { create: true, strict: true });
      database.run("PRAGMA foreign_keys = ON");
      database.transaction(() => {
        const version = database!
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version;

        if (version === 0) {
          const existingSchema = database!
            .query<{ present: number }, []>(
              "SELECT 1 AS present FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
            )
            .get();

          if (existingSchema) {
            throw incompatibleSchema;
          }

          initializationTestSeam.afterVersionZeroPreflight?.();
          database!.run(`
            CREATE TABLE library_items (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              source_path TEXT NOT NULL,
              format TEXT NOT NULL,
              added_at TEXT NOT NULL,
              author TEXT,
              description TEXT,
              cover_path TEXT,
              updated_at TEXT
            ) STRICT
          `);
          createMetadataTables(database!);
          verifyV2Database(database!);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 1) {
          retainVerifiedV1Backup(database!, this.#databasePath);
          database!.run("ALTER TABLE library_items ADD COLUMN author TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN description TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN cover_path TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN updated_at TEXT");
          createMetadataTables(database!);
          initializationTestSeam.duringV1ToV2Migration?.();
          verifyV2Database(database!);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version !== SCHEMA_VERSION) {
          throw incompatibleSchema;
        }
      }).immediate();

      this.#database = database;
      return success(null);
    } catch (error) {
      database?.close();
      return failure(error === incompatibleSchema ? "incompatible-schema" : "storage-unavailable");
    }
  }

  async list(_request: ListLibraryItemsRequest): Promise<ListLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const rows = this.#database
        .query<StoredLibraryItem, []>(`
          SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt,
            author, description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          ORDER BY rowid
        `)
        .all();
      const items: LibraryItem[] = [];
      for (const row of rows) {
        const item = readItem(this.#database, row);
        if (!item.ok) {
          return item;
        }
        items.push(item.value);
      }
      return success(items);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async get({ id }: GetLibraryItemRequest): Promise<GetLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const row = this.#database
        .query<StoredLibraryItem, [string]>(`
          SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt,
            author, description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          WHERE id = ?
        `)
        .get(id);
      return row ? readItem(this.#database, row) : success(null);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async add({ item }: AddLibraryItemRequest): Promise<AddLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const parsed = libraryItemSchema.safeParse(item);
    if (!parsed.success) {
      return failure("invalid-stored-data");
    }

    try {
      this.#database.transaction(() => {
        this.#database!.run(
          `INSERT INTO library_items
            (id, title, source_path, format, added_at, author, description, cover_path, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.data.id,
            parsed.data.title,
            parsed.data.sourcePath,
            parsed.data.format,
            parsed.data.addedAt,
            parsed.data.author ?? null,
            parsed.data.description ?? null,
            parsed.data.coverPath ?? null,
            parsed.data.updatedAt ?? null,
          ],
        );
        replaceTags(this.#database!, parsed.data);
      }).immediate();
      return success(parsed.data);
    } catch (error) {
      return failure(isDuplicateIdError(error) ? "duplicate-id" : "storage-unavailable");
    }
  }

  async remove({ id }: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      return this.#database.transaction(() => {
        const row = this.#database!
          .query<StoredLibraryItem, [string]>(`
            SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt,
              author, description, cover_path AS coverPath, updated_at AS updatedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);

        if (!row) {
          return success(null);
        }

        const item = readItem(this.#database!, row);
        if (!item.ok) {
          return item;
        }

        this.#database!.run("DELETE FROM library_items WHERE id = ?", [id]);
        return success(item.value);
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
