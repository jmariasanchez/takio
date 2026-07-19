import {
  bookFormatSchema,
  bookFormatsSchema,
  detectFormat,
  libraryItemSchema,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import type {
  AddLibraryItemRequest,
  AddLibraryItemResult,
  AttachLibraryFormatRequest,
  AttachLibraryFormatResult,
  GetLibraryItemRequest,
  GetLibraryItemResult,
  ImportLibraryItemRequest,
  ImportLibraryItemResult,
  LibraryStore,
  LibraryStoreErrorCode,
  LibraryStoreResult,
  ListLibraryItemsRequest,
  ListLibraryItemsResult,
  OpenLibraryRequest,
  OpenLibraryResult,
  RemoveLibraryCoverRequest,
  RemoveLibraryCoverResult,
  RemoveLibraryFormatRequest,
  RemoveLibraryFormatResult,
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
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { initializationTestSeam } from "./initialization-test-seam.js";
import { lifecycleTestSeam } from "./lifecycle-test-seam.js";

const SCHEMA_VERSION = 4;
const incompatibleSchema = Symbol("incompatible-schema");
const duplicateFormat = Symbol("duplicate-format");
const sourceChanged = Symbol("source-changed");

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
type StoredV3BookFormat = { sourcePath: unknown; format: unknown; addedAt: unknown };
type StoredBookFormat = StoredV3BookFormat & { provenance: unknown };
type StoredPositionedBookFormat = StoredBookFormat & { position: unknown };
type StoredPositionedV3BookFormat = StoredV3BookFormat & { position: unknown };
type StoredTag = { name: unknown };
type CleanupKind = "cover" | "format";
type StoredCleanupPath = { sourcePath: unknown; kind: unknown };
type CleanupJob = { sourcePath: string; kind: CleanupKind };

const managedLeafPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;

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

function isSqliteConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function validateManagedRoot(itemsDirectory: string): void {
  if (!existsSync(itemsDirectory)) {
    return;
  }

  const root = lstatSync(itemsDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new TypeError("Invalid managed items directory");
  }
}

function resolveManagedFormatPath(
  itemsDirectory: string,
  storedPath: unknown,
  format: FormatId,
  requireFile: boolean,
): string {
  if (
    typeof storedPath !== "string" ||
    !managedLeafPattern.test(storedPath) ||
    storedPath.includes("/") ||
    storedPath.includes("\\") ||
    detectFormat(storedPath) !== format
  ) {
    throw new TypeError("Invalid managed format path");
  }

  const root = resolve(itemsDirectory);
  validateManagedRoot(root);
  const path = join(root, storedPath);
  if (dirname(path) !== root) {
    throw new TypeError("Invalid managed format path");
  }

  if (!existsSync(path)) {
    if (requireFile) {
      throw new TypeError("Missing managed format file");
    }
    return path;
  }

  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new TypeError("Invalid managed format file");
  }

  if (realpathSync(dirname(path)) !== realpathSync(root) || dirname(realpathSync(path)) !== realpathSync(root)) {
    throw new TypeError("Invalid managed format path");
  }
  return path;
}

function readSource(sourcePath: string): { format: FormatId; path: string } | null {
  try {
    const path = realpathSync(sourcePath);
    if (!lstatSync(path).isFile()) {
      return null;
    }
    const format = detectFormat(path);
    return format ? { format, path } : null;
  } catch {
    return null;
  }
}

function managedLeafForReferencedPath(
  itemsDirectory: string,
  path: string,
  format: FormatId,
): string | null {
  const root = resolve(itemsDirectory);
  if (!existsSync(root)) {
    return null;
  }
  validateManagedRoot(root);
  const canonicalRoot = realpathSync(root);
  if (dirname(path) !== canonicalRoot) {
    return null;
  }
  const leaf = basename(path);
  if (!managedLeafPattern.test(leaf) || detectFormat(leaf) !== format) {
    return null;
  }
  return realpathSync(resolveManagedFormatPath(root, leaf, format, true)) === path ? leaf : null;
}

function referencedFormatUsesPath(database: Database, path: string): boolean {
  const referenced = database
    .query<{ sourcePath: unknown }, []>(`
      SELECT source_path AS sourcePath
      FROM library_item_formats
      WHERE provenance = 'referenced'
    `)
    .all();
  for (const row of referenced) {
    if (typeof row.sourcePath !== "string") {
      continue;
    }
    try {
      if (row.sourcePath === path || realpathSync(row.sourcePath) === realpathSync(path)) {
        return true;
      }
    } catch {
      // An invalid referenced row cannot own a managed file.
    }
  }
  return false;
}

function resolveCoverCleanupPath(coversDirectory: string, storedPath: unknown): string {
  const path = resolveOwnedCover(coversDirectory, storedPath);
  if (!existsSync(path)) {
    return path;
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new TypeError("Invalid stored cover path");
  }
  return path;
}

function cleanupOwnedFile(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
  job: { sourcePath: unknown; kind: unknown },
): boolean {
  if (typeof job.sourcePath !== "string" || (job.kind !== "format" && job.kind !== "cover")) {
    throw new TypeError("Invalid cleanup job");
  }
  const sourcePath = job.sourcePath;
  const kind: CleanupKind = job.kind;
  const path =
    kind === "format"
      ? (() => {
          const format = detectFormat(sourcePath);
          if (!format) {
            throw new TypeError("Invalid managed cleanup path");
          }
          return resolveManagedFormatPath(itemsDirectory, sourcePath, format, false);
        })()
      : resolveCoverCleanupPath(coversDirectory, sourcePath);

  return database.transaction(() => {
    const pending = database
      .query<{ present: number }, [string, string]>(
        "SELECT 1 AS present FROM managed_file_cleanup WHERE source_path = ? AND kind = ?",
      )
      .get(sourcePath, kind);
    if (!pending) {
      return true;
    }
    if (kind === "format" && existsSync(path) && referencedFormatUsesPath(database, path)) {
      database.run(
        "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
        [sourcePath],
      );
      return true;
    }
    try {
      lifecycleTestSeam.beforeManagedFileCleanup?.(path);
      unlinkSync(path);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        return false;
      }
    }
    database.run("DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = ?", [
      sourcePath,
      kind,
    ]);
    return true;
  }).immediate();
}

function attemptOwnedFileCleanup(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
  job: CleanupJob,
): boolean {
  try {
    return cleanupOwnedFile(database, coversDirectory, itemsDirectory, job);
  } catch {
    return false;
  }
}

function retryOwnedFileCleanup(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): boolean {
  const pending = database
    .query<StoredCleanupPath, []>(`
      SELECT source_path AS sourcePath, kind
      FROM managed_file_cleanup
      ORDER BY kind, source_path
    `)
    .all();
  let cleanupPending = false;
  for (const job of pending) {
    if (!cleanupOwnedFile(database, coversDirectory, itemsDirectory, job)) {
      cleanupPending = true;
    }
  }
  return cleanupPending;
}

function installManagedFile(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
  sourcePath: string,
  format: FormatId,
): { path: string; storedPath: string } {
  mkdirSync(itemsDirectory, { recursive: true });
  validateManagedRoot(itemsDirectory);

  const storedPath = `${crypto.randomUUID()}.${format}`;
  const path = resolveManagedFormatPath(itemsDirectory, storedPath, format, false);
  database.run(
    "INSERT INTO managed_file_cleanup (source_path, kind) VALUES (?, 'format')",
    [storedPath],
  );
  try {
    copyFileSync(sourcePath, path, constants.COPYFILE_EXCL);
    lifecycleTestSeam.afterManagedFileInstalled?.(path);
    return { path, storedPath };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      database.run(
        "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
        [storedPath],
      );
    } else {
      attemptOwnedFileCleanup(database, coversDirectory, itemsDirectory, {
        sourcePath: storedPath,
        kind: "format",
      });
    }
    throw error;
  }
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
  formats: unknown,
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
    formats,
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

  return parseItem(
    coversDirectory,
    row,
    row.sourcePath,
    row.format,
    [
      {
        sourcePath: row.sourcePath,
        format: row.format,
        addedAt: row.addedAt,
        provenance: "referenced",
      },
    ],
    readTags(database, row.id),
  );
}

function readItem(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
  row: StoredLibraryItem,
): LibraryStoreResult<LibraryItem> {
  if (typeof row.id !== "string") {
    return failure("invalid-stored-data");
  }

  const storedFormats = database
    .query<StoredPositionedBookFormat, [string]>(`
      SELECT source_path AS sourcePath, format, added_at AS addedAt, provenance, position
      FROM library_item_formats
      WHERE library_item_id = ?
      ORDER BY position
    `)
    .all(row.id);
  let publicFormats: unknown[];
  try {
    publicFormats = storedFormats.map(({ position: _position, ...format }) => ({
      ...format,
      sourcePath:
        format.provenance === "managed"
          ? resolveManagedFormatPath(itemsDirectory, format.sourcePath, format.format as FormatId, true)
          : format.sourcePath,
    }));
  } catch {
    return failure("invalid-stored-data");
  }
  const formats = bookFormatsSchema.safeParse(publicFormats);
  if (storedFormats[0]?.position !== 0 || !formats.success) {
    return failure("invalid-stored-data");
  }

  return parseItem(
    coversDirectory,
    row,
    formats.data[0]!.sourcePath,
    formats.data[0]!.format,
    formats.data,
    readTags(database, row.id),
  );
}

function readV3Item(
  database: Database,
  coversDirectory: string,
  row: StoredLibraryItem,
): LibraryStoreResult<LibraryItem> {
  if (typeof row.id !== "string") {
    return failure("invalid-stored-data");
  }

  const storedFormats = database
    .query<StoredPositionedV3BookFormat, [string]>(`
      SELECT source_path AS sourcePath, format, added_at AS addedAt, position
      FROM library_item_formats
      WHERE library_item_id = ?
      ORDER BY position
    `)
    .all(row.id);
  const formats = bookFormatsSchema.safeParse(
    storedFormats.map(({ position: _position, ...format }) => ({
      ...format,
      provenance: "referenced",
    })),
  );
  if (storedFormats[0]?.position !== 0 || !formats.success) {
    return failure("invalid-stored-data");
  }

  return parseItem(
    coversDirectory,
    row,
    formats.data[0]!.sourcePath,
    formats.data[0]!.format,
    formats.data,
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

function createV3FormatTable(database: Database): void {
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

function createFormatTable(database: Database): void {
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
}

function ensureManagedCleanupTable(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS managed_file_cleanup (
      source_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format', 'cover'))
    ) STRICT
  `);
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(managed_file_cleanup)").all();
  if (!columns.some(({ name }) => name === "kind")) {
    database.run(
      `ALTER TABLE managed_file_cleanup
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format', 'cover'))`,
    );
  }
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

  if (
    version !== 1 ||
    integrity !== "ok" ||
    rows.some(
      (row) =>
        !libraryItemSchema.safeParse({
          ...row,
          formats: [
            {
              sourcePath: row.sourcePath,
              format: row.format,
              addedAt: row.addedAt,
              provenance: "referenced",
            },
          ],
        }).success,
    )
  ) {
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
  createV3FormatTable(database);
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
    .query<StoredPositionedV3BookFormat, []>(`
      SELECT source_path AS sourcePath, format, added_at AS addedAt, position
      FROM library_item_formats
      ORDER BY library_item_id, position
    `)
    .all();

  if (
    integrity !== "ok" ||
    foreignKeyViolations.length > 0 ||
    itemWithoutFormat ||
    formats.some(
      ({ position: _position, ...format }) =>
        !bookFormatSchema.safeParse({ ...format, provenance: "referenced" }).success,
    )
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

  if (rows.some((row) => !readV3Item(database, coversDirectory, row).ok)) {
    throw new Error("The migrated database could not be verified.");
  }
}

function verifyV3Backup(path: string, coversDirectory: string): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;

  if (version !== 3) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV3Database(backup, coversDirectory);
}

function retainVerifiedV3Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v3.backup`, (path) =>
    verifyV3Backup(path, coversDirectory),
  );
}

function migrateV3ToV4(database: Database): void {
  database.run("ALTER TABLE library_item_formats RENAME TO library_item_formats_v3");
  createFormatTable(database);
  database.run(`
    INSERT INTO library_item_formats
      (library_item_id, format, source_path, added_at, provenance, position)
    SELECT library_item_id, format, source_path, added_at, 'referenced', position
    FROM library_item_formats_v3
  `);
  database.run("DROP TABLE library_item_formats_v3");
  initializationTestSeam.duringV3ToV4Migration?.();
}

function verifyV4Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
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
  const rows = database
    .query<StoredLibraryItem, []>(`
      SELECT id, title, added_at AS addedAt,
        author, description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      ORDER BY rowid
    `)
    .all();

  if (
    integrity !== "ok" ||
    foreignKeyViolations.length > 0 ||
    itemWithoutFormat ||
    rows.some((row) => !readItem(database, coversDirectory, itemsDirectory, row).ok)
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
  itemsDirectory: string,
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
  return row ? readItem(database, coversDirectory, itemsDirectory, row) : success(null);
}

function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

export class BunSqliteLibraryStore implements LibraryStore {
  readonly #databasePath: string;
  readonly #coversDirectory: string;
  readonly #itemsDirectory: string;
  #database: Database | null = null;

  constructor(databasePath: string) {
    if (databasePath.length === 0) {
      throw new TypeError("A database path is required.");
    }

    this.#databasePath = databasePath;
    this.#coversDirectory = join(dirname(resolve(databasePath)), "covers");
    this.#itemsDirectory = join(dirname(resolve(databasePath)), "items");
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
          verifyV4Database(database!, this.#coversDirectory, this.#itemsDirectory);
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
          migrateV3ToV4(database!);
          verifyV4Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 2) {
          retainVerifiedV2Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV2ToV3(database!);
          migrateV3ToV4(database!);
          verifyV4Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 3) {
          retainVerifiedV3Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV3ToV4(database!);
          verifyV4Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version !== SCHEMA_VERSION) {
          throw incompatibleSchema;
        }
        ensureManagedCleanupTable(database!);
      }).immediate();

      retryOwnedFileCleanup(database, this.#coversDirectory, this.#itemsDirectory);
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
        const item = readItem(this.#database, this.#coversDirectory, this.#itemsDirectory, row);
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
      return readStoredItem(this.#database, this.#coversDirectory, this.#itemsDirectory, id);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async add({ item }: AddLibraryItemRequest): Promise<AddLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const parsed = libraryItemSchema.safeParse(item);
    if (
      !parsed.success ||
      parsed.data.coverPath ||
      parsed.data.formats.length !== 1 ||
      parsed.data.formats[0]?.provenance !== "referenced"
    ) {
      return failure("invalid-stored-data");
    }

    const primaryFormat = parsed.data.formats[0]!;
    let cleanupHandoff: { leaf: string; path: string; format: FormatId } | null = null;
    const inspected = readSource(primaryFormat.sourcePath);
    if (inspected && inspected.format === primaryFormat.format) {
      try {
        const leaf = managedLeafForReferencedPath(
          this.#itemsDirectory,
          inspected.path,
          inspected.format,
        );
        if (leaf) {
          cleanupHandoff = { leaf, path: inspected.path, format: inspected.format };
        }
      } catch {
        return failure("storage-unavailable");
      }
    }

    try {
      this.#database.transaction(() => {
        if (cleanupHandoff) {
          const revalidated = readSource(primaryFormat.sourcePath);
          if (
            !revalidated ||
            revalidated.path !== cleanupHandoff.path ||
            revalidated.format !== cleanupHandoff.format
          ) {
            throw sourceChanged;
          }
          this.#database!.run(
            "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
            [cleanupHandoff.leaf],
          );
        }
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
            (library_item_id, format, source_path, added_at, provenance, position)
            VALUES (?, ?, ?, ?, 'referenced', 0)`,
          [
            parsed.data.id,
            primaryFormat.format,
            primaryFormat.sourcePath,
            primaryFormat.addedAt,
          ],
        );
        writeTags(this.#database!, parsed.data.id, parsed.data.tags);
      }).immediate();
      const stored = readStoredItem(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        parsed.data.id,
      );
      return stored.ok && stored.value ? success(stored.value) : failure("invalid-stored-data");
    } catch (error) {
      return failure(isDuplicateIdError(error) ? "duplicate-id" : "storage-unavailable");
    }
  }

  async import({ sourcePath, title }: ImportLibraryItemRequest): Promise<ImportLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const source = readSource(sourcePath);
    const normalizedTitle =
      title === undefined && source
        ? basename(source.path, extname(source.path)).trim()
        : typeof title === "string"
          ? title.trim()
          : "";
    if (!source || normalizedTitle.length === 0) {
      return failure("invalid-arguments");
    }

    const id = crypto.randomUUID();
    const addedAt = new Date().toISOString();
    let installed: { path: string; storedPath: string };
    try {
      installed = installManagedFile(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        source.path,
        source.format,
      );
    } catch {
      return failure("storage-unavailable");
    }

    const item = libraryItemSchema.safeParse({
      id,
      title: normalizedTitle,
      sourcePath: installed.path,
      format: source.format,
      addedAt,
      formats: [
        {
          sourcePath: installed.path,
          format: source.format,
          addedAt,
          provenance: "managed",
        },
      ],
      tags: [],
    });
    if (!item.success) {
      attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
        sourcePath: installed.storedPath,
        kind: "format",
      });
      return failure("invalid-stored-data");
    }

    try {
      this.#database.transaction(() => {
        this.#database!.run(
          `INSERT INTO library_items
            (id, title, added_at, author, description, cover_path, updated_at)
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
          [id, normalizedTitle, addedAt],
        );
        this.#database!.run(
          `INSERT INTO library_item_formats
            (library_item_id, format, source_path, added_at, provenance, position)
            VALUES (?, ?, ?, ?, 'managed', 0)`,
          [id, source.format, installed.storedPath, addedAt],
        );
        this.#database!.run(
          "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
          [installed.storedPath],
        );
      }).immediate();
    } catch (error) {
      attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
        sourcePath: installed.storedPath,
        kind: "format",
      });
      return failure(isDuplicateIdError(error) ? "duplicate-id" : "storage-unavailable");
    }

    const stored = readStoredItem(
      this.#database,
      this.#coversDirectory,
      this.#itemsDirectory,
      id,
    );
    return stored.ok && stored.value ? success(stored.value) : failure("invalid-stored-data");
  }

  async attachFormat({ id, source }: AttachLibraryFormatRequest): Promise<AttachLibraryFormatResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const current = readStoredItem(
      this.#database,
      this.#coversDirectory,
      this.#itemsDirectory,
      id,
    );
    if (!current.ok || !current.value) {
      return current;
    }
    if (!source || (source.kind !== "copy" && source.kind !== "reference")) {
      return failure("invalid-arguments");
    }
    const inspected = readSource(source.path);
    if (!inspected) {
      return failure("invalid-arguments");
    }
    if (current.value.formats.some(({ format }) => format === inspected.format)) {
      return failure("duplicate-format");
    }

    const addedAt = new Date().toISOString();
    let installed: { path: string; storedPath: string } | undefined;
    try {
      if (source.kind === "copy") {
        installed = installManagedFile(
          this.#database,
          this.#coversDirectory,
          this.#itemsDirectory,
          inspected.path,
          inspected.format,
        );
      }

      const outcome = this.#database.transaction(() => {
        const itemExists = this.#database!
          .query<{ present: number }, [string]>(
            "SELECT 1 AS present FROM library_items WHERE id = ?",
          )
          .get(id);
        if (!itemExists) {
          return "missing" as const;
        }
        const duplicate = this.#database!
          .query<{ present: number }, [string, string]>(
            "SELECT 1 AS present FROM library_item_formats WHERE library_item_id = ? AND format = ?",
          )
          .get(id, inspected.format);
        if (duplicate) {
          throw duplicateFormat;
        }

        let storedSourcePath = installed?.storedPath ?? inspected.path;
        if (!installed) {
          const revalidated = readSource(source.path);
          if (
            !revalidated ||
            revalidated.path !== inspected.path ||
            revalidated.format !== inspected.format
          ) {
            throw sourceChanged;
          }
          storedSourcePath = revalidated.path;
          const managedLeaf = managedLeafForReferencedPath(
            this.#itemsDirectory,
            revalidated.path,
            revalidated.format,
          );
          if (managedLeaf) {
            this.#database!.run(
              "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
              [managedLeaf],
            );
          }
        }

        this.#database!.run(
          `INSERT INTO library_item_formats
            (library_item_id, format, source_path, added_at, provenance, position)
            VALUES (?, ?, ?, ?, ?,
              (SELECT COALESCE(MAX(position), -1) + 1
                FROM library_item_formats WHERE library_item_id = ?))`,
          [
            id,
            inspected.format,
            storedSourcePath,
            addedAt,
            installed ? "managed" : "referenced",
            id,
          ],
        );
        this.#database!.run("UPDATE library_items SET updated_at = ? WHERE id = ?", [addedAt, id]);
        if (installed) {
          this.#database!.run(
            "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
            [installed.storedPath],
          );
        }
        return "attached" as const;
      }).immediate();
      if (outcome === "missing") {
        if (installed) {
          attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
            sourcePath: installed.storedPath,
            kind: "format",
          });
        }
        return success(null);
      }
    } catch (error) {
      if (installed) {
        attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
          sourcePath: installed.storedPath,
          kind: "format",
        });
      }
      if (error === duplicateFormat) {
        return failure("duplicate-format");
      }
      if (isSqliteConstraintError(error)) {
        const duplicate = this.#database
          .query<{ present: number }, [string, string]>(
            "SELECT 1 AS present FROM library_item_formats WHERE library_item_id = ? AND format = ?",
          )
          .get(id, inspected.format);
        if (duplicate) {
          return failure("duplicate-format");
        }
        const exists = this.#database
          .query<{ present: number }, [string]>("SELECT 1 AS present FROM library_items WHERE id = ?")
          .get(id);
        if (!exists) {
          return success(null);
        }
      }
      return failure("storage-unavailable");
    }

    return readStoredItem(this.#database, this.#coversDirectory, this.#itemsDirectory, id);
  }

  async removeFormat({ id, format }: RemoveLibraryFormatRequest): Promise<RemoveLibraryFormatResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    type Outcome =
      | { kind: "missing" }
      | { kind: "unchanged"; item: LibraryItem }
      | { kind: "removed"; cleanupPath?: string }
      | { kind: "failure"; code: LibraryStoreErrorCode };
    let outcome: Outcome;
    try {
      outcome = this.#database.transaction((): Outcome => {
        const current = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          id,
        );
        if (!current.ok) {
          return { kind: "failure", code: current.error.code };
        }
        if (!current.value) {
          return { kind: "missing" };
        }
        if (!current.value.formats.some((candidate) => candidate.format === format)) {
          return { kind: "unchanged", item: current.value };
        }
        if (current.value.formats.length === 1) {
          return { kind: "failure", code: "last-format" };
        }

        const stored = this.#database!
          .query<StoredPositionedBookFormat, [string, string]>(`
            SELECT source_path AS sourcePath, format, added_at AS addedAt, provenance, position
            FROM library_item_formats
            WHERE library_item_id = ? AND format = ?
          `)
          .get(id, format);
        if (!stored) {
          return { kind: "unchanged", item: current.value };
        }
        const cleanupPath =
          stored.provenance === "managed" && typeof stored.sourcePath === "string"
            ? stored.sourcePath
            : undefined;
        if (stored.provenance === "managed") {
          if (!cleanupPath) {
            return { kind: "failure", code: "invalid-stored-data" };
          }
          resolveManagedFormatPath(this.#itemsDirectory, cleanupPath, format, true);
        }
        if (cleanupPath !== undefined) {
          this.#database!.run(
            "INSERT OR IGNORE INTO managed_file_cleanup (source_path, kind) VALUES (?, 'format')",
            [cleanupPath],
          );
        }
        this.#database!.run(
          "DELETE FROM library_item_formats WHERE library_item_id = ? AND format = ?",
          [id, format],
        );
        const remaining = this.#database!
          .query<{ format: string }, [string]>(`
            SELECT format
            FROM library_item_formats
            WHERE library_item_id = ?
            ORDER BY position
          `)
          .all(id);
        this.#database!.run(
          "UPDATE library_item_formats SET position = position + ? WHERE library_item_id = ?",
          [remaining.length + 1, id],
        );
        for (const [position, remainingFormat] of remaining.entries()) {
          this.#database!.run(
            "UPDATE library_item_formats SET position = ? WHERE library_item_id = ? AND format = ?",
            [position, id, remainingFormat.format],
          );
        }
        this.#database!.run("UPDATE library_items SET updated_at = ? WHERE id = ?", [
          new Date().toISOString(),
          id,
        ]);
        return { kind: "removed", cleanupPath };
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }

    if (outcome.kind === "failure") {
      return failure(outcome.code);
    }
    if (outcome.kind === "missing") {
      return success({ item: null, cleanupPending: false });
    }
    if (outcome.kind === "unchanged") {
      return success({ item: outcome.item, cleanupPending: false });
    }

    const item = readStoredItem(
      this.#database,
      this.#coversDirectory,
      this.#itemsDirectory,
      id,
    );
    if (!item.ok || !item.value) {
      return item.ok ? failure("invalid-stored-data") : item;
    }
    const cleanupPending =
      outcome.cleanupPath === undefined
        ? false
        : !attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
            sourcePath: outcome.cleanupPath,
            kind: "format",
          });
    return success({ item: item.value, cleanupPending });
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
        const current = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          id,
        );
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
        return readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          id,
        );
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
      current = readStoredItem(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        id,
      );
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

    const updated = readStoredItem(
      this.#database,
      this.#coversDirectory,
      this.#itemsDirectory,
      id,
    );
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
      const current = readStoredItem(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        id,
      );
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
      const updated = readStoredItem(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        id,
      );
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
        const item = readItem(this.#database, this.#coversDirectory, this.#itemsDirectory, row);
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

    type Outcome =
      | { kind: "missing" }
      | { kind: "removed"; item: LibraryItem; jobs: CleanupJob[] }
      | { kind: "failure"; code: LibraryStoreErrorCode };
    let outcome: Outcome;
    try {
      outcome = this.#database.transaction((): Outcome => {
        const row = this.#database!
          .query<StoredLibraryItem, [string]>(`
            SELECT id, title, added_at AS addedAt,
              author, description, cover_path AS coverPath, updated_at AS updatedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);
        if (!row) {
          return { kind: "missing" };
        }
        const current = readItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          row,
        );
        if (!current.ok) {
          return { kind: "failure", code: current.error.code };
        }

        lifecycleTestSeam.duringManagedItemRemoval?.();
        const managedFormats = this.#database!
          .query<StoredPositionedBookFormat, [string]>(`
            SELECT source_path AS sourcePath, format, added_at AS addedAt, provenance, position
            FROM library_item_formats
            WHERE library_item_id = ? AND provenance = 'managed'
            ORDER BY position
          `)
          .all(id);
        const jobs: CleanupJob[] = [];
        for (const managed of managedFormats) {
          const parsedFormat = bookFormatSchema.safeParse({
            sourcePath: managed.sourcePath,
            format: managed.format,
            addedAt: managed.addedAt,
            provenance: managed.provenance,
          });
          if (!parsedFormat.success || parsedFormat.data.provenance !== "managed") {
            return { kind: "failure", code: "invalid-stored-data" };
          }
          resolveManagedFormatPath(
            this.#itemsDirectory,
            parsedFormat.data.sourcePath,
            parsedFormat.data.format,
            true,
          );
          jobs.push({ sourcePath: parsedFormat.data.sourcePath, kind: "format" });
        }
        if (row.coverPath != null) {
          if (typeof row.coverPath !== "string") {
            return { kind: "failure", code: "invalid-stored-data" };
          }
          resolveCoverCleanupPath(this.#coversDirectory, row.coverPath);
          jobs.push({ sourcePath: row.coverPath, kind: "cover" });
        }
        for (const job of jobs) {
          this.#database!.run(
            "INSERT OR IGNORE INTO managed_file_cleanup (source_path, kind) VALUES (?, ?)",
            [job.sourcePath, job.kind],
          );
        }
        this.#database!.run("DELETE FROM library_items WHERE id = ?", [id]);
        this.#database!.run(`
          DELETE FROM tags
          WHERE NOT EXISTS (
            SELECT 1 FROM library_item_tags
            WHERE library_item_tags.tag_normalized_name = tags.normalized_name
          )
        `);
        return { kind: "removed", item: current.value, jobs };
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }

    if (outcome.kind === "failure") {
      return failure(outcome.code);
    }
    if (outcome.kind === "missing") {
      return success({ item: null, cleanupPending: false });
    }
    let cleanupPending = false;
    for (const job of outcome.jobs) {
      if (
        !attemptOwnedFileCleanup(
          this.#database,
          this.#coversDirectory,
          this.#itemsDirectory,
          job,
        )
      ) {
        cleanupPending = true;
      }
    }
    return success({ item: outcome.item, cleanupPending });
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
