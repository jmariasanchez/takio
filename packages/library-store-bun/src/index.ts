import { bookFormatSchema, libraryItemSchema, type LibraryItem } from "@takio/core";
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
  RemoveLibraryCoverRequest,
  RemoveLibraryCoverResult,
  RemoveLibraryItemRequest,
  RemoveLibraryItemResult,
  SearchLibraryItemsRequest,
  SearchLibraryItemsResult,
  SetLibraryCoverRequest,
  SetLibraryCoverResult,
  UpdateLibraryItemRequest,
  UpdateLibraryItemResult,
} from "@takio/library-contract";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { initializationTestSeam } from "./initialization-test-seam.js";

const SCHEMA_VERSION = 3;
const incompatibleSchema = Symbol("incompatible-schema");

type StoredLibraryItem = {
  id: unknown;
  title: unknown;
  addedAt: unknown;
  author: unknown;
  description: unknown;
  coverPath: unknown;
  updatedAt: unknown;
};

type StoredV2LibraryItem = StoredLibraryItem & {
  sourcePath: unknown;
  format: unknown;
};
type StoredV1LibraryItem = Pick<StoredV2LibraryItem, "id" | "title" | "sourcePath" | "format" | "addedAt">;
type StoredBookFormat = { sourcePath: unknown; format: unknown; addedAt: unknown };
type StoredPositionedBookFormat = StoredBookFormat & { position: unknown };
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

function readTags(database: Database, itemId: string): unknown[] {
  return database
    .query<StoredTag, [string]>(`
      SELECT tags.name
      FROM library_item_tags
      JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
      WHERE library_item_tags.library_item_id = ?
      ORDER BY library_item_tags.position
    `)
    .all(itemId)
    .map(({ name }) => name);
}

function parseItem(
  coversDirectory: string,
  row: StoredLibraryItem,
  sourcePath: unknown,
  format: unknown,
  tags: unknown[],
): LibraryStoreResult<LibraryItem> {
  let coverPath: string | undefined;
  try {
    coverPath = row.coverPath == null ? undefined : resolveOwnedCover(coversDirectory, row.coverPath);
  } catch {
    return failure("invalid-stored-data");
  }

  const parsed = libraryItemSchema.safeParse({
    ...row,
    sourcePath,
    format,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    coverPath,
    updatedAt: row.updatedAt ?? undefined,
    tags,
  });
  return parsed.success ? success(parsed.data) : failure("invalid-stored-data");
}

function readV2Item(
  database: Database,
  coversDirectory: string,
  row: StoredV2LibraryItem,
): LibraryStoreResult<LibraryItem> {
  if (typeof row.id !== "string") {
    return failure("invalid-stored-data");
  }

  return parseItem(coversDirectory, row, row.sourcePath, row.format, readTags(database, row.id));
}

function readItem(
  database: Database,
  coversDirectory: string,
  row: StoredLibraryItem,
): LibraryStoreResult<LibraryItem> {
  if (typeof row.id !== "string") {
    return failure("invalid-stored-data");
  }

  const storedFormats = database
    .query<StoredPositionedBookFormat, [string]>(`
      SELECT source_path AS sourcePath, format, added_at AS addedAt, position
      FROM library_item_formats
      WHERE library_item_id = ?
      ORDER BY position
    `)
    .all(row.id);
  const formats = bookFormatSchema.array().safeParse(
    storedFormats.map(({ position: _position, ...format }) => format),
  );
  if (storedFormats[0]?.position !== 0 || !formats.success) {
    return failure("invalid-stored-data");
  }

  return parseItem(
    coversDirectory,
    row,
    formats.data[0]!.sourcePath,
    formats.data[0]!.format,
    readTags(database, row.id),
  );
}

function isInside(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function resolveOwnedCover(coversDirectory: string, storedPath: unknown): string {
  if (typeof storedPath !== "string" || isAbsolute(storedPath)) {
    throw new TypeError("Invalid stored cover path");
  }

  const resolvedRoot = resolve(coversDirectory);
  const resolvedPath = resolve(resolvedRoot, storedPath);
  if (!isInside(resolvedRoot, resolvedPath)) {
    throw new TypeError("Invalid stored cover path");
  }

  if (existsSync(resolvedPath) && !isInside(realpathSync(resolvedRoot), realpathSync(resolvedPath))) {
    throw new TypeError("Invalid stored cover path");
  }
  return resolvedPath;
}

function removeOwnedCover(coversDirectory: string, storedPath: string): void {
  const path = resolveOwnedCover(coversDirectory, storedPath);
  if (!isInside(realpathSync(coversDirectory), realpathSync(path))) {
    throw new TypeError("Invalid stored cover path");
  }
  unlinkSync(path);
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

function createFormatTable(database: Database): void {
  database.run(`
    CREATE TABLE library_item_formats (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      source_path TEXT NOT NULL,
      added_at TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (library_item_id, format),
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

function retainVerifiedBackup(
  database: Database,
  backupPath: string,
  verify: (path: string) => void,
): void {
  const temporaryPath = `${backupPath}.${crypto.randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, database.serialize());
    verify(temporaryPath);
    renameSync(temporaryPath, backupPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function retainVerifiedV1Backup(database: Database, databasePath: string): void {
  retainVerifiedBackup(database, `${databasePath}.v1.backup`, verifyV1Backup);
}

function verifyV2Backup(path: string, coversDirectory: string): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  const integrity = backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    ?.integrity_check;
  const foreignKeyViolations = backup.query("PRAGMA foreign_key_check").all();
  const rows = backup
    .query<StoredV2LibraryItem, []>(`
      SELECT id, title, source_path AS sourcePath, format, added_at AS addedAt,
        author, description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      ORDER BY rowid
    `)
    .all();

  if (
    version !== 2 ||
    integrity !== "ok" ||
    foreignKeyViolations.length > 0 ||
    rows.some((row) => !readV2Item(backup, coversDirectory, row).ok)
  ) {
    throw new Error("The pre-migration backup could not be verified.");
  }
}

function retainVerifiedV2Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v2.backup`, (path) =>
    verifyV2Backup(path, coversDirectory),
  );
}

function migrateV2ToV3(database: Database): void {
  createFormatTable(database);
  database.run(`
    INSERT INTO library_item_formats
      (library_item_id, format, source_path, added_at, position)
    SELECT id, format, source_path, added_at, 0
    FROM library_items
  `);
  database.run("ALTER TABLE library_items DROP COLUMN source_path");
  database.run("ALTER TABLE library_items DROP COLUMN format");
  initializationTestSeam.duringV2ToV3Migration?.();
}

function verifyV3Structure(database: Database): void {
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
    ?.integrity_check;
  const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all();
  const itemWithoutFormat = database
    .query<{ id: string }, []>(`
      SELECT library_items.id
      FROM library_items
      WHERE NOT EXISTS (
        SELECT 1
        FROM library_item_formats
        WHERE library_item_formats.library_item_id = library_items.id
          AND library_item_formats.position = 0
      )
      LIMIT 1
    `)
    .get();
  const formats = database
    .query<StoredPositionedBookFormat, []>(`
      SELECT source_path AS sourcePath, format, added_at AS addedAt, position
      FROM library_item_formats
      ORDER BY library_item_id, position
    `)
    .all();

  if (
    integrity !== "ok" ||
    foreignKeyViolations.length > 0 ||
    itemWithoutFormat ||
    formats.some(({ position: _position, ...format }) => !bookFormatSchema.safeParse(format).success)
  ) {
    throw new Error("The library database structure could not be verified.");
  }
}

function verifyV3Database(database: Database, coversDirectory: string): void {
  verifyV3Structure(database);
  const rows = database
    .query<StoredLibraryItem, []>(`
      SELECT id, title, added_at AS addedAt,
        author, description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      ORDER BY rowid
    `)
    .all();

  if (
    rows.some((row) => !readItem(database, coversDirectory, row).ok)
  ) {
    throw new Error("The migrated database could not be verified.");
  }
}

function writeTags(database: Database, itemId: string, tags: readonly string[]): void {
  for (const [position, name] of tags.entries()) {
    const normalizedName = name.toLowerCase();
    database.run("INSERT OR IGNORE INTO tags (normalized_name, name) VALUES (?, ?)", [
      normalizedName,
      name,
    ]);
    database.run(
      `INSERT INTO library_item_tags
        (library_item_id, tag_normalized_name, position) VALUES (?, ?, ?)`,
      [itemId, normalizedName, position],
    );
  }
}

function readStoredItem(
  database: Database,
  coversDirectory: string,
  id: string,
): LibraryStoreResult<LibraryItem | null> {
  const row = database
    .query<StoredLibraryItem, [string]>(`
      SELECT id, title, added_at AS addedAt,
        author, description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      WHERE id = ?
    `)
    .get(id);
  return row ? readItem(database, coversDirectory, row) : success(null);
}

function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

export class BunSqliteLibraryStore implements LibraryStore {
  readonly #databasePath: string;
  readonly #coversDirectory: string;
  #database: Database | null = null;

  constructor(databasePath: string) {
    if (databasePath.length === 0) {
      throw new TypeError("A database path is required.");
    }

    this.#databasePath = databasePath;
    this.#coversDirectory = join(dirname(resolve(databasePath)), "covers");
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
              added_at TEXT NOT NULL,
              author TEXT,
              description TEXT,
              cover_path TEXT,
              updated_at TEXT
            ) STRICT
          `);
          createMetadataTables(database!);
          createFormatTable(database!);
          verifyV3Database(database!, this.#coversDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 1) {
          retainVerifiedV1Backup(database!, this.#databasePath);
          database!.run("ALTER TABLE library_items ADD COLUMN author TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN description TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN cover_path TEXT");
          database!.run("ALTER TABLE library_items ADD COLUMN updated_at TEXT");
          createMetadataTables(database!);
          initializationTestSeam.duringV1ToV2Migration?.();
          migrateV2ToV3(database!);
          verifyV3Database(database!, this.#coversDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 2) {
          retainVerifiedV2Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV2ToV3(database!);
          verifyV3Database(database!, this.#coversDirectory);
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
          SELECT id, title, added_at AS addedAt,
            author, description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          ORDER BY title COLLATE NOCASE, id
        `)
        .all();
      const items: LibraryItem[] = [];
      for (const row of rows) {
        const item = readItem(this.#database, this.#coversDirectory, row);
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
      return readStoredItem(this.#database, this.#coversDirectory, id);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async add({ item }: AddLibraryItemRequest): Promise<AddLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const parsed = libraryItemSchema.safeParse(item);
    if (!parsed.success || parsed.data.coverPath) {
      return failure("invalid-stored-data");
    }

    try {
      this.#database.transaction(() => {
        this.#database!.run(
          `INSERT INTO library_items
            (id, title, added_at, author, description, cover_path, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.data.id,
            parsed.data.title,
            parsed.data.addedAt,
            parsed.data.author ?? null,
            parsed.data.description ?? null,
            parsed.data.coverPath ?? null,
            parsed.data.updatedAt ?? null,
          ],
        );
        this.#database!.run(
          `INSERT INTO library_item_formats
            (library_item_id, format, source_path, added_at, position)
            VALUES (?, ?, ?, ?, 0)`,
          [parsed.data.id, parsed.data.format, parsed.data.sourcePath, parsed.data.addedAt],
        );
        writeTags(this.#database!, parsed.data.id, parsed.data.tags);
      }).immediate();
      const stored = readStoredItem(this.#database, this.#coversDirectory, parsed.data.id);
      return stored.ok && stored.value ? success(stored.value) : failure("invalid-stored-data");
    } catch (error) {
      return failure(isDuplicateIdError(error) ? "duplicate-id" : "storage-unavailable");
    }
  }

  async update({ id, patch }: UpdateLibraryItemRequest): Promise<UpdateLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    if (!Array.isArray(patch.tags)) {
      return failure("invalid-stored-data");
    }

    try {
      return this.#database.transaction(() => {
        const current = readStoredItem(this.#database!, this.#coversDirectory, id);
        if (!current.ok || !current.value) {
          return current;
        }

        const updated = libraryItemSchema.safeParse({
          ...current.value,
          title:
            typeof patch.title === "string"
              ? patch.title.trim()
              : (patch.title ?? current.value.title),
          author:
            patch.author === null
              ? undefined
              : typeof patch.author === "string"
                ? patch.author.trim()
                : (patch.author ?? current.value.author),
          description:
            patch.description === null
              ? undefined
              : typeof patch.description === "string"
                ? patch.description.trim()
                : (patch.description ?? current.value.description),
          tags: patch.tags,
          updatedAt: new Date().toISOString(),
        });
        if (!updated.success) {
          return failure<LibraryItem | null>("invalid-stored-data");
        }

        this.#database!.run(
          `UPDATE library_items
            SET title = ?, author = ?, description = ?, updated_at = ?
            WHERE id = ?`,
          [
            updated.data.title,
            updated.data.author ?? null,
            updated.data.description ?? null,
            updated.data.updatedAt ?? null,
            id,
          ],
        );
        this.#database!.run("DELETE FROM library_item_tags WHERE library_item_id = ?", [id]);
        writeTags(this.#database!, id, updated.data.tags);
        this.#database!.run(`
          DELETE FROM tags
          WHERE NOT EXISTS (
            SELECT 1 FROM library_item_tags
            WHERE library_item_tags.tag_normalized_name = tags.normalized_name
          )
        `);
        return readStoredItem(this.#database!, this.#coversDirectory, id);
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  async setCover({ id, sourcePath }: SetLibraryCoverRequest): Promise<SetLibraryCoverResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    let current: LibraryStoreResult<LibraryItem | null>;
    try {
      current = readStoredItem(this.#database, this.#coversDirectory, id);
      if (!current.ok || !current.value) {
        return current;
      }
      if (!statSync(sourcePath).isFile()) {
        return failure("storage-unavailable");
      }
    } catch {
      return failure("storage-unavailable");
    }

    const filename = `${crypto.randomUUID()}${extname(sourcePath).toLowerCase()}`;
    const priorStoredPath = current.value.coverPath
      ? relative(this.#coversDirectory, current.value.coverPath)
      : null;
    const temporaryPath = join(this.#coversDirectory, `.${filename}.tmp`);
    const installedPath = join(this.#coversDirectory, filename);
    try {
      mkdirSync(this.#coversDirectory, { recursive: true });
      copyFileSync(sourcePath, temporaryPath);
      renameSync(temporaryPath, installedPath);
    } catch {
      rmSync(temporaryPath, { force: true });
      rmSync(installedPath, { force: true });
      return failure("storage-unavailable");
    }

    try {
      this.#database.transaction(() => {
        const changed = this.#database!.run(
          `UPDATE library_items SET cover_path = ?, updated_at = ?
            WHERE id = ? AND cover_path IS ?`,
          [filename, new Date().toISOString(), id, priorStoredPath],
        );
        if (changed.changes !== 1) {
          throw new Error("The library item changed while installing its cover.");
        }
      }).immediate();
    } catch {
      rmSync(installedPath, { force: true });
      return failure("storage-unavailable");
    }

    const updated = readStoredItem(this.#database, this.#coversDirectory, id);
    if (!updated.ok || !updated.value) {
      return updated;
    }

    if (current.value.coverPath) {
      try {
        removeOwnedCover(
          this.#coversDirectory,
          priorStoredPath!,
        );
      } catch {
        return failure("storage-unavailable");
      }
    }
    return updated;
  }

  async removeCover({ id }: RemoveLibraryCoverRequest): Promise<RemoveLibraryCoverResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const current = readStoredItem(this.#database, this.#coversDirectory, id);
      if (!current.ok || !current.value || !current.value.coverPath) {
        return current;
      }
      const storedCoverPath = relative(this.#coversDirectory, current.value.coverPath);
      this.#database.transaction(() => {
        this.#database!.run(
          "UPDATE library_items SET cover_path = NULL, updated_at = ? WHERE id = ?",
          [new Date().toISOString(), id],
        );
      }).immediate();
      const updated = readStoredItem(this.#database, this.#coversDirectory, id);
      removeOwnedCover(this.#coversDirectory, storedCoverPath);
      return updated;
    } catch {
      return failure("storage-unavailable");
    }
  }

  async search({ query }: SearchLibraryItemsRequest): Promise<SearchLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const pattern = `%${escapeLike(query)}%`;
      const rows = this.#database
        .query<StoredLibraryItem, [string, string, string, string]>(`
          SELECT id, title, added_at AS addedAt,
            author, description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR author LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR description LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR EXISTS (
              SELECT 1
              FROM library_item_tags
              JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
              WHERE library_item_tags.library_item_id = library_items.id
                AND tags.name LIKE ? ESCAPE '\\' COLLATE NOCASE
            )
          ORDER BY title COLLATE NOCASE, id
        `)
        .all(pattern, pattern, pattern, pattern);
      const items: LibraryItem[] = [];
      for (const row of rows) {
        const item = readItem(this.#database, this.#coversDirectory, row);
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

  async remove({ id }: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      const removed = this.#database.transaction(() => {
        const row = this.#database!
          .query<StoredLibraryItem, [string]>(`
            SELECT id, title, added_at AS addedAt,
              author, description, cover_path AS coverPath, updated_at AS updatedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);

        if (!row) {
          return success(null);
        }

        const item = readItem(this.#database!, this.#coversDirectory, row);
        if (!item.ok) {
          return item;
        }

        this.#database!.run("DELETE FROM library_items WHERE id = ?", [id]);
        this.#database!.run(`
          DELETE FROM tags
          WHERE NOT EXISTS (
            SELECT 1 FROM library_item_tags
            WHERE library_item_tags.tag_normalized_name = tags.normalized_name
          )
        `);
        return success(item.value);
      }).immediate();
      if (removed.ok && removed.value?.coverPath) {
        removeOwnedCover(
          this.#coversDirectory,
          relative(this.#coversDirectory, removed.value.coverPath),
        );
      }
      return removed;
    } catch {
      return failure("storage-unavailable");
    }
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
