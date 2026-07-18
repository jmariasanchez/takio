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

const SCHEMA_VERSION = 1;

type StoredLibraryItem = {
  id: unknown;
  title: unknown;
  sourcePath: unknown;
  format: unknown;
  addedAt: unknown;
};

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

function readItem(row: StoredLibraryItem): LibraryStoreResult<LibraryItem> {
  const parsed = libraryItemSchema.safeParse(row);
  return parsed.success ? success(parsed.data) : failure("invalid-stored-data");
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
      const version = database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;

      if (version === 0) {
        database.transaction(() => {
          database!.run(`
            CREATE TABLE library_items (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              source_path TEXT NOT NULL,
              format TEXT NOT NULL,
              added_at TEXT NOT NULL
            ) STRICT
          `);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        })();
      } else if (version !== SCHEMA_VERSION) {
        database.close();
        return failure("incompatible-schema");
      }

      this.#database = database;
      return success(null);
    } catch {
      database?.close();
      return failure("storage-unavailable");
    }
  }

  async list(_request: ListLibraryItemsRequest): Promise<ListLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const rows = this.#database
        .query<StoredLibraryItem, []>(`
          SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt
          FROM library_items
          ORDER BY rowid
        `)
        .all();
      const parsed = libraryItemSchema.array().safeParse(rows);
      return parsed.success ? success(parsed.data) : failure("invalid-stored-data");
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
          SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt
          FROM library_items
          WHERE id = ?
        `)
        .get(id);
      return row ? readItem(row) : success(null);
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
      this.#database.run(
        `INSERT INTO library_items (id, title, source_path, format, added_at) VALUES (?, ?, ?, ?, ?)`,
        [
          parsed.data.id,
          parsed.data.title,
          parsed.data.sourcePath,
          parsed.data.format,
          parsed.data.addedAt,
        ],
      );
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
            SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);

        if (!row) {
          return success(null);
        }

        const item = readItem(row);
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
