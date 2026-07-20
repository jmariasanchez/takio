import {
  bookFormatSchema,
  bookFormatsSchema,
  detectFormat,
  libraryItemSchema,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import {
  libraryMetadataPatchSchema,
  libraryQueryPageSchema,
  libraryTrashPageSchema,
  listLibraryTrashRequestSchema,
  listSavedLibraryViewsRequestSchema,
  purgeLibraryItemRequestSchema,
  queryLibraryItemsRequestSchema,
  replaceLibraryFormatRequestSchema,
  removeSavedLibraryViewRequestSchema,
  restoreLibraryItemRequestSchema,
  savedLibraryViewSchema,
  saveSavedLibraryViewRequestSchema,
  trashLibraryItemRequestSchema,
} from "@takio/library-contract";
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
  LibraryFormatReplacementStore,
  LibraryItemTrashStore,
  LibraryQueryStore,
  ListLibraryTrashRequest,
  ListLibraryTrashResult,
  ListSavedLibraryViewsRequest,
  ListSavedLibraryViewsResult,
  ListLibraryItemsRequest,
  ListLibraryItemsResult,
  OpenLibraryRequest,
  OpenLibraryResult,
  PurgeLibraryItemRequest,
  PurgeLibraryItemResult,
  RemoveLibraryCoverRequest,
  RemoveLibraryCoverResult,
  RemoveLibraryFormatRequest,
  RemoveLibraryFormatResult,
  RemoveLibraryItemRequest,
  RemoveLibraryItemResult,
  RemoveSavedLibraryViewRequest,
  RemoveSavedLibraryViewResult,
  RestoreLibraryItemRequest,
  RestoreLibraryItemResult,
  SearchLibraryItemsRequest,
  SearchLibraryItemsResult,
  QueryLibraryItemsRequest,
  QueryLibraryItemsResult,
  ReplaceLibraryFormatRequest,
  ReplaceLibraryFormatResult,
  SavedLibraryView,
  SavedLibraryViewStore,
  SaveSavedLibraryViewRequest,
  SaveSavedLibraryViewResult,
  SetLibraryCoverRequest,
  SetLibraryCoverResult,
  TrashLibraryItemRequest,
  TrashLibraryItemResult,
  UpdateLibraryItemRequest,
  UpdateLibraryItemResult,
} from "@takio/library-contract";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
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
import { queryTestSeam } from "./query-test-seam.js";

const SCHEMA_VERSION = 6;
const incompatibleSchema = Symbol("incompatible-schema");
const duplicateFormat = Symbol("duplicate-format");
const sourceChanged = Symbol("source-changed");
const installedArtifactMismatch = Symbol("installed-artifact-mismatch");

type StoredLibraryItem = {
  id: unknown;
  title: unknown;
  addedAt: unknown;
  author: unknown;
  series?: unknown;
  seriesIndex?: unknown;
  publisher?: unknown;
  publishedDate?: unknown;
  rating?: unknown;
  description: unknown;
  coverPath: unknown;
  updatedAt: unknown;
};
type StoredTrashLibraryItem = StoredLibraryItem & { trashedAt: unknown };

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
type StoredAuthor = { name: unknown; sortName: unknown; position: unknown };
type StoredLanguage = { language: unknown; position: unknown };
type StoredIdentifier = { scheme: unknown; value: unknown };
type StoredItemFormat = StoredPositionedBookFormat & { libraryItemId: string };
type StoredItemTag = StoredTag & { libraryItemId: string; position: unknown };
type StoredItemAuthor = StoredAuthor & { libraryItemId: string };
type StoredItemLanguage = StoredLanguage & { libraryItemId: string };
type StoredItemIdentifier = StoredIdentifier & { libraryItemId: string };
type StoredSavedLibraryView = {
  id: unknown;
  name: unknown;
  definitionJson: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};
type CleanupKind = "cover" | "format";
type StoredCleanupPath = { sourcePath: unknown; kind: unknown };
type CleanupJob = { sourcePath: string; kind: CleanupKind };
type ExpectedArtifact = { bytes: number; sha256: string };

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

function isValidExpectedArtifact(value: unknown): value is ExpectedArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function managedFileMatchesArtifact(path: string, expected: ExpectedArtifact): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== expected.bytes) {
      return false;
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) {
        break;
      }
      bytes += read;
      if (bytes > expected.bytes) {
        return false;
      }
      hash.update(buffer.subarray(0, read));
    }

    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    return (
      bytes === expected.bytes &&
      hash.digest("hex") === expected.sha256 &&
      after.isFile() &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      after.dev === current.dev &&
      after.ino === current.ino &&
      after.size === current.size
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
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

type StoredRichMetadata = {
  authors?: unknown;
  languages?: unknown;
  identifiers?: unknown;
};

function readRichMetadata(
  database: Database,
  itemId: string,
): LibraryStoreResult<StoredRichMetadata> {
  const storedAuthors = database
    .query<StoredAuthor, [string]>(`
      SELECT name, sort_name AS sortName, position
      FROM library_item_authors
      WHERE library_item_id = ?
      ORDER BY position
    `)
    .all(itemId);
  const storedLanguages = database
    .query<StoredLanguage, [string]>(`
      SELECT language, position
      FROM library_item_languages
      WHERE library_item_id = ?
      ORDER BY position
    `)
    .all(itemId);

  if (
    storedAuthors.some(({ position }, index) => position !== index) ||
    storedLanguages.some(({ position }, index) => position !== index)
  ) {
    return failure("invalid-stored-data");
  }

  const storedIdentifiers = database
    .query<StoredIdentifier, [string]>(`
      SELECT scheme, value
      FROM library_item_identifiers
      WHERE library_item_id = ?
      ORDER BY scheme
    `)
    .all(itemId);
  const identifierEntries: [string, unknown][] = [];
  const schemes = new Set<string>();
  for (const { scheme, value } of storedIdentifiers) {
    if (typeof scheme !== "string") {
      return failure("invalid-stored-data");
    }
    const canonicalScheme = scheme.trim();
    if (canonicalScheme.length === 0 || scheme !== canonicalScheme || schemes.has(canonicalScheme)) {
      return failure("invalid-stored-data");
    }
    schemes.add(canonicalScheme);
    identifierEntries.push([canonicalScheme, value]);
  }

  return success({
    authors:
      storedAuthors.length === 0
        ? undefined
        : storedAuthors.map(({ name, sortName }) => ({
            name,
            sortName: sortName ?? undefined,
          })),
    languages:
      storedLanguages.length === 0
        ? undefined
        : storedLanguages.map(({ language }) => language),
    identifiers:
      identifierEntries.length === 0
        ? undefined
        : Object.fromEntries(identifierEntries),
  });
}

function parseItem(
  coversDirectory: string,
  row: StoredLibraryItem,
  sourcePath: unknown,
  format: unknown,
  formats: unknown,
  tags: unknown[],
  richMetadata: StoredRichMetadata = {},
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
    ...richMetadata,
    series: row.series ?? undefined,
    seriesIndex: row.seriesIndex ?? undefined,
    publisher: row.publisher ?? undefined,
    publishedDate: row.publishedDate ?? undefined,
    rating: row.rating ?? undefined,
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
  includeRichMetadata = true,
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

  const richMetadata = includeRichMetadata ? readRichMetadata(database, row.id) : success({});
  if (!richMetadata.ok) {
    return richMetadata;
  }

  return parseItem(
    coversDirectory,
    row,
    formats.data[0]!.sourcePath,
    formats.data[0]!.format,
    formats.data,
    readTags(database, row.id),
    richMetadata.value,
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

function createRichMetadataTables(database: Database): void {
  database.run(`
    CREATE TABLE library_item_authors (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_name TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (library_item_id, position)
    ) STRICT
  `);
  database.run(`
    CREATE TABLE library_item_languages (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (library_item_id, position)
    ) STRICT
  `);
  database.run(`
    CREATE TABLE library_item_identifiers (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      scheme TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (library_item_id, scheme)
    ) STRICT
  `);
}

function createSavedLibraryViewsTable(database: Database): void {
  database.run(`
    CREATE TABLE saved_library_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
}

function createLibraryQueryIndexes(database: Database): void {
  database.run(
    "CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE, id)",
  );
  database.run(
    "CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE, id)",
  );
  database.run(
    `CREATE INDEX library_items_by_series
      ON library_items(series COLLATE NOCASE, series_index, id)`,
  );
  database.run(
    "CREATE INDEX library_items_by_published_date ON library_items(published_date, id)",
  );
  database.run("CREATE INDEX library_items_by_rating ON library_items(rating, id)");
  database.run("CREATE INDEX library_items_by_added_at ON library_items(added_at, id)");
  database.run("CREATE INDEX library_items_by_updated_at ON library_items(updated_at, id)");
  database.run(
    `CREATE INDEX library_item_tags_by_tag
      ON library_item_tags(tag_normalized_name, library_item_id)`,
  );
  database.run(
    `CREATE INDEX library_item_formats_by_format
      ON library_item_formats(format, library_item_id)`,
  );
  database.run(
    `CREATE INDEX library_item_authors_by_name
      ON library_item_authors(name COLLATE NOCASE, library_item_id)`,
  );
  database.run(
    `CREATE INDEX library_item_languages_by_language
      ON library_item_languages(language COLLATE NOCASE, library_item_id)`,
  );
  database.run(
    `CREATE INDEX saved_library_views_by_name
      ON saved_library_views(name COLLATE NOCASE, id)`,
  );
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

function migrateV4ToV5(database: Database): void {
  database.run("ALTER TABLE library_items ADD COLUMN series TEXT");
  database.run("ALTER TABLE library_items ADD COLUMN series_index REAL");
  database.run("ALTER TABLE library_items ADD COLUMN publisher TEXT");
  database.run("ALTER TABLE library_items ADD COLUMN published_date TEXT");
  database.run("ALTER TABLE library_items ADD COLUMN rating REAL CHECK (rating >= 0 AND rating <= 10)");
  createRichMetadataTables(database);
  createSavedLibraryViewsTable(database);
  createLibraryQueryIndexes(database);
  initializationTestSeam.duringV4ToV5Migration?.();
}

function createLibraryTrashIndex(database: Database): void {
  database.run(`
    CREATE INDEX library_items_by_trashed_at
    ON library_items(trashed_at DESC, id ASC)
    WHERE trashed_at IS NOT NULL
  `);
}

function migrateV5ToV6(database: Database): void {
  database.run("ALTER TABLE library_items ADD COLUMN trashed_at TEXT");
  createLibraryTrashIndex(database);
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
    rows.some((row) => !readItem(database, coversDirectory, itemsDirectory, row, false).ok)
  ) {
    throw new Error("The migrated database could not be verified.");
  }
}

function verifyV4Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;

  if (version !== 4) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV4Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV4Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v4.backup`, (path) =>
    verifyV4Backup(path, coversDirectory, itemsDirectory),
  );
}

function verifyV5Database(
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
      SELECT id, title, added_at AS addedAt, author,
        series, series_index AS seriesIndex, publisher,
        published_date AS publishedDate, rating,
        description, cover_path AS coverPath, updated_at AS updatedAt
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

function verifyV5Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;

  if (version !== 5) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV5Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV5Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v5.backup`, (path) =>
    verifyV5Backup(path, coversDirectory, itemsDirectory),
  );
}

function isStoredTrashTimestamp(value: unknown): value is string {
  return bookFormatSchema.safeParse({
    sourcePath: "trash-validation.epub",
    format: "epub",
    addedAt: value,
    provenance: "referenced",
  }).success;
}

function verifyV6Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  verifyV5Database(database, coversDirectory, itemsDirectory);
  const rows = database
    .query<{ trashedAt: unknown }, []>(
      "SELECT trashed_at AS trashedAt FROM library_items ORDER BY rowid",
    )
    .all();
  if (rows.some(({ trashedAt }) => trashedAt !== null && !isStoredTrashTimestamp(trashedAt))) {
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

function writeAuthors(
  database: Database,
  itemId: string,
  authors: NonNullable<LibraryItem["authors"]>,
): void {
  for (const [position, author] of authors.entries()) {
    database.run(
      `INSERT INTO library_item_authors
        (library_item_id, name, sort_name, position) VALUES (?, ?, ?, ?)`,
      [itemId, author.name, author.sortName ?? null, position],
    );
  }
}

function writeLanguages(
  database: Database,
  itemId: string,
  languages: NonNullable<LibraryItem["languages"]>,
): void {
  for (const [position, language] of languages.entries()) {
    database.run(
      `INSERT INTO library_item_languages
        (library_item_id, language, position) VALUES (?, ?, ?)`,
      [itemId, language, position],
    );
  }
}

function writeIdentifiers(
  database: Database,
  itemId: string,
  identifiers: NonNullable<LibraryItem["identifiers"]>,
): void {
  for (const [scheme, value] of Object.entries(identifiers)) {
    database.run(
      `INSERT INTO library_item_identifiers
        (library_item_id, scheme, value) VALUES (?, ?, ?)`,
      [itemId, scheme, value],
    );
  }
}

function writeRichMetadata(database: Database, item: LibraryItem): void {
  writeAuthors(database, item.id, item.authors ?? []);
  writeLanguages(database, item.id, item.languages ?? []);
  writeIdentifiers(database, item.id, item.identifiers ?? {});
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
        author, series, series_index AS seriesIndex, publisher,
        published_date AS publishedDate, rating,
        description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      WHERE id = ?
    `)
    .get(id);
  return row ? readItem(database, coversDirectory, itemsDirectory, row) : success(null);
}

function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

type LibraryFacet = "authors" | "tags" | "series" | "languages" | "formats";
type SqlParameter = string | number;
type SqlFragment = { sql: string; parameters: SqlParameter[] };
type StoredFacetRow = { facet: unknown; value: unknown; count: unknown };
type StoredLibraryQueryRow = StoredLibraryItem & { total: unknown };
const libraryFacets: readonly LibraryFacet[] = [
  "authors",
  "tags",
  "series",
  "languages",
  "formats",
];

function buildLibrarySearch(request: QueryLibraryItemsRequest): SqlFragment {
  const clauses: string[] = [];
  const parameters: SqlParameter[] = [];

  if (request.query.length > 0) {
    const pattern = `%${escapeLike(request.query)}%`;
    clauses.push(`(
      library_items.title LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR library_items.author LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR library_items.series LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR library_items.publisher LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR library_items.description LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR EXISTS (
        SELECT 1 FROM library_item_authors
        WHERE library_item_authors.library_item_id = library_items.id
          AND (library_item_authors.name LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR library_item_authors.sort_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
      )
      OR EXISTS (
        SELECT 1 FROM library_item_tags
        JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
        WHERE library_item_tags.library_item_id = library_items.id
          AND tags.name LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
      OR EXISTS (
        SELECT 1 FROM library_item_identifiers
        WHERE library_item_identifiers.library_item_id = library_items.id
          AND library_item_identifiers.value LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
    )`);
    parameters.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return { sql: clauses.length === 0 ? "1" : clauses.join(" AND "), parameters };
}

function buildLibraryFacetFilter(
  request: QueryLibraryItemsRequest,
  facet: LibraryFacet,
): SqlFragment {
  if (facet === "authors" && request.filters.authors.length > 0) {
    const values = JSON.stringify(request.filters.authors);
    return {
      sql: `(
        library_items.author COLLATE NOCASE IN (SELECT value FROM json_each(?))
        OR EXISTS (
          SELECT 1 FROM library_item_authors
          WHERE library_item_authors.library_item_id = library_items.id
            AND library_item_authors.name COLLATE NOCASE IN (SELECT value FROM json_each(?))
        )
      )`,
      parameters: [values, values],
    };
  }
  if (facet === "tags" && request.filters.tags.length > 0) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_item_tags
        WHERE library_item_tags.library_item_id = library_items.id
          AND library_item_tags.tag_normalized_name IN (SELECT value FROM json_each(?))
      )`,
      parameters: [JSON.stringify(request.filters.tags.map((tag) => tag.toLowerCase()))],
    };
  }
  if (facet === "series" && request.filters.series.length > 0) {
    return {
      sql: "library_items.series COLLATE NOCASE IN (SELECT value FROM json_each(?))",
      parameters: [JSON.stringify(request.filters.series)],
    };
  }
  if (facet === "languages" && request.filters.languages.length > 0) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_item_languages
        WHERE library_item_languages.library_item_id = library_items.id
          AND library_item_languages.language COLLATE NOCASE IN (SELECT value FROM json_each(?))
      )`,
      parameters: [JSON.stringify(request.filters.languages)],
    };
  }
  if (facet === "formats" && request.filters.formats.length > 0) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_item_formats
        WHERE library_item_formats.library_item_id = library_items.id
          AND library_item_formats.format IN (SELECT value FROM json_each(?))
      )`,
      parameters: [JSON.stringify(request.filters.formats)],
    };
  }
  return { sql: "1", parameters: [] };
}

function buildLibraryMatch(
  request: QueryLibraryItemsRequest,
  omittedFacet?: LibraryFacet,
): SqlFragment {
  const fragments = [
    { sql: "library_items.trashed_at IS NULL", parameters: [] },
    buildLibrarySearch(request),
    ...libraryFacets
      .filter((facet) => facet !== omittedFacet)
      .map((facet) => buildLibraryFacetFilter(request, facet)),
  ];
  return {
    sql: fragments.map(({ sql }) => sql).filter((sql) => sql !== "1").join(" AND ") || "1",
    parameters: fragments.flatMap(({ parameters }) => parameters),
  };
}

function buildLibraryOrder(request: QueryLibraryItemsRequest): string {
  const direction = request.sort.direction === "ascending" ? "ASC" : "DESC";
  const scalar = {
    title: "library_items.title COLLATE NOCASE",
    author:
      "COALESCE(primary_author.sort_name, primary_author.name, library_items.author) COLLATE NOCASE",
    series: "library_items.series COLLATE NOCASE",
    publishedDate: "library_items.published_date",
    rating: "library_items.rating",
    addedAt: "library_items.added_at",
    updatedAt: "library_items.updated_at",
  }[request.sort.field];
  const seriesIndex =
    request.sort.field === "series"
      ? `, library_items.series_index ${direction} NULLS LAST`
      : "";
  return `${scalar} ${direction} NULLS LAST${seriesIndex}, library_items.id ASC`;
}

function buildFacetQuery(request: QueryLibraryItemsRequest): SqlFragment {
  const search = buildLibrarySearch(request);
  const filters = Object.fromEntries(
    libraryFacets.map((facet) => [facet, buildLibraryFacetFilter(request, facet)]),
  ) as Record<LibraryFacet, SqlFragment>;
  return {
    sql: `
      WITH facet_candidates AS MATERIALIZED (
        SELECT library_items.id, library_items.series,
          ${filters.authors.sql} AS matches_authors,
          ${filters.tags.sql} AS matches_tags,
          ${filters.series.sql} AS matches_series,
          ${filters.languages.sql} AS matches_languages,
          ${filters.formats.sql} AS matches_formats
        FROM library_items
        WHERE library_items.trashed_at IS NULL
          AND ${search.sql}
      )
      SELECT facet, value, count FROM (
        SELECT 'authors' AS facet, MIN(author_values.value) AS value,
          COUNT(DISTINCT author_values.library_item_id) AS count
        FROM (
          SELECT id AS library_item_id, author AS value
          FROM library_items WHERE author IS NOT NULL
          UNION ALL
          SELECT library_item_id, name AS value FROM library_item_authors
        ) AS author_values
        JOIN facet_candidates
          ON facet_candidates.id = author_values.library_item_id
        WHERE facet_candidates.matches_tags
          AND facet_candidates.matches_series
          AND facet_candidates.matches_languages
          AND facet_candidates.matches_formats
        GROUP BY author_values.value COLLATE NOCASE

        UNION ALL

        SELECT 'tags' AS facet, MIN(tags.name) AS value,
          COUNT(*) AS count
        FROM library_item_tags
        JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
        JOIN facet_candidates
          ON facet_candidates.id = library_item_tags.library_item_id
        WHERE facet_candidates.matches_authors
          AND facet_candidates.matches_series
          AND facet_candidates.matches_languages
          AND facet_candidates.matches_formats
        GROUP BY tags.normalized_name

        UNION ALL

        SELECT 'series' AS facet, MIN(facet_candidates.series) AS value,
          COUNT(*) AS count
        FROM facet_candidates
        WHERE facet_candidates.series IS NOT NULL
          AND facet_candidates.matches_authors
          AND facet_candidates.matches_tags
          AND facet_candidates.matches_languages
          AND facet_candidates.matches_formats
        GROUP BY facet_candidates.series COLLATE NOCASE

        UNION ALL

        SELECT 'languages' AS facet, MIN(library_item_languages.language) AS value,
          COUNT(DISTINCT facet_candidates.id) AS count
        FROM library_item_languages
        JOIN facet_candidates
          ON facet_candidates.id = library_item_languages.library_item_id
        WHERE facet_candidates.matches_authors
          AND facet_candidates.matches_tags
          AND facet_candidates.matches_series
          AND facet_candidates.matches_formats
        GROUP BY library_item_languages.language COLLATE NOCASE

        UNION ALL

        SELECT 'formats' AS facet, MIN(library_item_formats.format) AS value,
          COUNT(*) AS count
        FROM library_item_formats
        JOIN facet_candidates
          ON facet_candidates.id = library_item_formats.library_item_id
        WHERE facet_candidates.matches_authors
          AND facet_candidates.matches_tags
          AND facet_candidates.matches_series
          AND facet_candidates.matches_languages
        GROUP BY library_item_formats.format
      )
      ORDER BY facet, value COLLATE NOCASE, value
    `,
    parameters: [
      ...filters.authors.parameters,
      ...filters.tags.parameters,
      ...filters.series.parameters,
      ...filters.languages.parameters,
      ...filters.formats.parameters,
      ...search.parameters,
    ],
  };
}

function groupStoredRows<T extends { libraryItemId: string }>(
  ids: readonly string[],
  rows: readonly T[],
): Map<string, T[]> | null {
  const grouped = new Map(ids.map((id) => [id, [] as T[]]));
  for (const row of rows) {
    const group = grouped.get(row.libraryItemId);
    if (!group) {
      return null;
    }
    group.push(row);
  }
  return grouped;
}

function hydrateLibraryPage(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
  rows: readonly StoredLibraryItem[],
): LibraryStoreResult<readonly LibraryItem[]> {
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || ids.includes(row.id)) {
      return failure("invalid-stored-data");
    }
    ids.push(row.id);
  }
  if (ids.length === 0) {
    return success([]);
  }

  const encodedIds = JSON.stringify(ids);
  queryTestSeam.beforeHydrationQuery?.("formats");
  const formats = database
    .query<StoredItemFormat, [string]>(`
      SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
        format, added_at AS addedAt, provenance, position
      FROM library_item_formats
      WHERE library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_id, position
    `)
    .all(encodedIds);
  queryTestSeam.beforeHydrationQuery?.("tags");
  const tags = database
    .query<StoredItemTag, [string]>(`
      SELECT library_item_tags.library_item_id AS libraryItemId,
        tags.name, library_item_tags.position
      FROM library_item_tags
      JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
      WHERE library_item_tags.library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_tags.library_item_id, library_item_tags.position
    `)
    .all(encodedIds);
  queryTestSeam.beforeHydrationQuery?.("authors");
  const authors = database
    .query<StoredItemAuthor, [string]>(`
      SELECT library_item_id AS libraryItemId, name, sort_name AS sortName, position
      FROM library_item_authors
      WHERE library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_id, position
    `)
    .all(encodedIds);
  queryTestSeam.beforeHydrationQuery?.("languages");
  const languages = database
    .query<StoredItemLanguage, [string]>(`
      SELECT library_item_id AS libraryItemId, language, position
      FROM library_item_languages
      WHERE library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_id, position
    `)
    .all(encodedIds);
  queryTestSeam.beforeHydrationQuery?.("identifiers");
  const identifiers = database
    .query<StoredItemIdentifier, [string]>(`
      SELECT library_item_id AS libraryItemId, scheme, value
      FROM library_item_identifiers
      WHERE library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_id, scheme
    `)
    .all(encodedIds);

  const groupedFormats = groupStoredRows(ids, formats);
  const groupedTags = groupStoredRows(ids, tags);
  const groupedAuthors = groupStoredRows(ids, authors);
  const groupedLanguages = groupStoredRows(ids, languages);
  const groupedIdentifiers = groupStoredRows(ids, identifiers);
  if (
    !groupedFormats ||
    !groupedTags ||
    !groupedAuthors ||
    !groupedLanguages ||
    !groupedIdentifiers
  ) {
    return failure("invalid-stored-data");
  }

  const items: LibraryItem[] = [];
  for (const row of rows) {
    const id = row.id as string;
    const storedFormats = groupedFormats.get(id)!;
    const storedAuthors = groupedAuthors.get(id)!;
    const storedLanguages = groupedLanguages.get(id)!;
    if (
      storedFormats.some(({ position }, index) => position !== index) ||
      storedAuthors.some(({ position }, index) => position !== index) ||
      storedLanguages.some(({ position }, index) => position !== index)
    ) {
      return failure("invalid-stored-data");
    }

    let publicFormats: unknown[];
    try {
      publicFormats = storedFormats.map(({ libraryItemId: _itemId, position: _position, ...format }) => ({
        ...format,
        sourcePath:
          format.provenance === "managed"
            ? resolveManagedFormatPath(
                itemsDirectory,
                format.sourcePath,
                format.format as FormatId,
                true,
              )
            : format.sourcePath,
      }));
    } catch {
      return failure("invalid-stored-data");
    }
    const parsedFormats = bookFormatsSchema.safeParse(publicFormats);
    if (!parsedFormats.success) {
      return failure("invalid-stored-data");
    }

    const identifierEntries: [string, unknown][] = [];
    const schemes = new Set<string>();
    for (const { scheme, value } of groupedIdentifiers.get(id)!) {
      if (typeof scheme !== "string") {
        return failure("invalid-stored-data");
      }
      const canonicalScheme = scheme.trim();
      if (canonicalScheme.length === 0 || canonicalScheme !== scheme || schemes.has(scheme)) {
        return failure("invalid-stored-data");
      }
      schemes.add(scheme);
      identifierEntries.push([scheme, value]);
    }

    const item = parseItem(
      coversDirectory,
      row,
      parsedFormats.data[0]!.sourcePath,
      parsedFormats.data[0]!.format,
      parsedFormats.data,
      groupedTags.get(id)!.map(({ name }) => name),
      {
        authors:
          storedAuthors.length === 0
            ? undefined
            : storedAuthors.map(({ name, sortName }) => ({
                name,
                sortName: sortName ?? undefined,
              })),
        languages:
          storedLanguages.length === 0
            ? undefined
            : storedLanguages.map(({ language }) => language),
        identifiers:
          identifierEntries.length === 0 ? undefined : Object.fromEntries(identifierEntries),
      },
    );
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return success(items);
}

function parseSavedLibraryView(row: StoredSavedLibraryView): LibraryStoreResult<SavedLibraryView> {
  if (typeof row.definitionJson !== "string") {
    return failure("invalid-stored-data");
  }
  try {
    const parsed = savedLibraryViewSchema.safeParse({
      id: row.id,
      name: row.name,
      definition: JSON.parse(row.definitionJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    return parsed.success ? success(parsed.data) : failure("invalid-stored-data");
  } catch {
    return failure("invalid-stored-data");
  }
}

export class BunSqliteLibraryStore
  implements
    LibraryStore,
    LibraryFormatReplacementStore,
    LibraryItemTrashStore,
    LibraryQueryStore,
    SavedLibraryViewStore
{
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
              series TEXT,
              series_index REAL,
              publisher TEXT,
              published_date TEXT,
              rating REAL CHECK (rating >= 0 AND rating <= 10),
              description TEXT,
              cover_path TEXT,
              updated_at TEXT,
              trashed_at TEXT
            ) STRICT
          `);
          createMetadataTables(database!);
          createFormatTable(database!);
          createRichMetadataTables(database!);
          createSavedLibraryViewsTable(database!);
          createLibraryQueryIndexes(database!);
          createLibraryTrashIndex(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
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
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 2) {
          retainVerifiedV2Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV2ToV3(database!);
          migrateV3ToV4(database!);
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 3) {
          retainVerifiedV3Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV3ToV4(database!);
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 4) {
          retainVerifiedV4Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 5) {
          retainVerifiedV5Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV5ToV6(database!);
          verifyV6Database(database!, this.#coversDirectory, this.#itemsDirectory);
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
            author, series, series_index AS seriesIndex, publisher,
            published_date AS publishedDate, rating,
            description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          WHERE trashed_at IS NULL
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

  async listTrash(request: ListLibraryTrashRequest): Promise<ListLibraryTrashResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = listLibraryTrashRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    try {
      return this.#database.transaction((): ListLibraryTrashResult => {
        const rows = this.#database!
          .query<StoredTrashLibraryItem, [number, number]>(`
            SELECT id, title, added_at AS addedAt,
              author, series, series_index AS seriesIndex, publisher,
              published_date AS publishedDate, rating,
              description, cover_path AS coverPath, updated_at AS updatedAt,
              trashed_at AS trashedAt
            FROM library_items
            WHERE trashed_at IS NOT NULL
            ORDER BY trashed_at DESC, id ASC
            LIMIT ? OFFSET ?
          `)
          .all(parsedRequest.data.page.limit, parsedRequest.data.page.offset);
        if (rows.some(({ trashedAt }) => !isStoredTrashTimestamp(trashedAt))) {
          return failure("invalid-stored-data");
        }
        const items = hydrateLibraryPage(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          rows,
        );
        if (!items.ok) {
          return items;
        }
        const total = this.#database!
          .query<{ total: unknown }, []>(
            "SELECT COUNT(*) AS total FROM library_items WHERE trashed_at IS NOT NULL",
          )
          .get()?.total;
        const page = libraryTrashPageSchema.safeParse({
          items: items.value,
          total,
          page: parsedRequest.data.page,
        });
        return page.success ? success(page.data) : failure("invalid-stored-data");
      })();
    } catch {
      return failure("storage-unavailable");
    }
  }

  #setTrashState(id: string, shouldTrash: boolean): LibraryStoreResult<LibraryItem | null> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    try {
      return this.#database.transaction((): LibraryStoreResult<LibraryItem | null> => {
        const row = this.#database!
          .query<StoredTrashLibraryItem, [string]>(`
            SELECT id, title, added_at AS addedAt,
              author, series, series_index AS seriesIndex, publisher,
              published_date AS publishedDate, rating,
              description, cover_path AS coverPath, updated_at AS updatedAt,
              trashed_at AS trashedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);
        if (!row) {
          return success(null);
        }
        if (row.trashedAt !== null && !isStoredTrashTimestamp(row.trashedAt)) {
          return failure("invalid-stored-data");
        }
        const item = readItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          row,
        );
        if (!item.ok) {
          return item;
        }
        if (shouldTrash && row.trashedAt === null) {
          this.#database!.run("UPDATE library_items SET trashed_at = ? WHERE id = ?", [
            new Date().toISOString(),
            id,
          ]);
        } else if (!shouldTrash && row.trashedAt !== null) {
          this.#database!.run("UPDATE library_items SET trashed_at = NULL WHERE id = ?", [id]);
        }
        return success(item.value);
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  async trash(request: TrashLibraryItemRequest): Promise<TrashLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = trashLibraryItemRequestSchema.safeParse(request);
    return parsedRequest.success
      ? this.#setTrashState(parsedRequest.data.id, true)
      : failure("invalid-arguments");
  }

  async restore(request: RestoreLibraryItemRequest): Promise<RestoreLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = restoreLibraryItemRequestSchema.safeParse(request);
    return parsedRequest.success
      ? this.#setTrashState(parsedRequest.data.id, false)
      : failure("invalid-arguments");
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
            (id, title, added_at, author, series, series_index, publisher,
              published_date, rating, description, cover_path, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.data.id,
            parsed.data.title,
            parsed.data.addedAt,
            parsed.data.author ?? null,
            parsed.data.series ?? null,
            parsed.data.seriesIndex ?? null,
            parsed.data.publisher ?? null,
            parsed.data.publishedDate ?? null,
            parsed.data.rating ?? null,
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
        writeRichMetadata(this.#database!, parsed.data);
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

    if (!source || (source.kind !== "copy" && source.kind !== "reference")) {
      return failure("invalid-arguments");
    }
    if (source.kind === "reference" && "expectedArtifact" in source) {
      return failure("invalid-arguments");
    }
    const expectedArtifact =
      source.kind === "copy"
        ? (source as typeof source & { expectedArtifact?: unknown }).expectedArtifact
        : undefined;
    if (expectedArtifact !== undefined && !isValidExpectedArtifact(expectedArtifact)) {
      return failure("invalid-arguments");
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
        if (expectedArtifact && !managedFileMatchesArtifact(installed.path, expectedArtifact)) {
          throw installedArtifactMismatch;
        }
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

        if (
          installed &&
          expectedArtifact &&
          !managedFileMatchesArtifact(installed.path, expectedArtifact)
        ) {
          throw installedArtifactMismatch;
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
      if (error === installedArtifactMismatch) {
        return failure("invalid-arguments");
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

  async replaceFormat(request: ReplaceLibraryFormatRequest): Promise<ReplaceLibraryFormatResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const parsed = replaceLibraryFormatRequestSchema.safeParse(request);
    if (!parsed.success) {
      return failure("invalid-arguments");
    }
    const { id, format, expectedCurrent, source } = parsed.data;
    const inspected = readSource(source.path);
    if (!inspected || inspected.format !== format) {
      return failure("invalid-arguments");
    }

    const expectedArtifact = source.kind === "copy" ? source.expectedArtifact : undefined;
    let installed: { path: string; storedPath: string } | undefined;
    type Outcome =
      | { kind: "replaced"; item: LibraryItem; cleanupPath?: string }
      | { kind: "format-changed" }
      | { kind: "failure"; code: LibraryStoreErrorCode };

    try {
      if (source.kind === "copy") {
        installed = installManagedFile(
          this.#database,
          this.#coversDirectory,
          this.#itemsDirectory,
          inspected.path,
          format,
        );
        if (expectedArtifact && !managedFileMatchesArtifact(installed.path, expectedArtifact)) {
          throw installedArtifactMismatch;
        }
      }

      const currentTimestamp = new Date().toISOString();
      const addedAt =
        currentTimestamp === expectedCurrent.addedAt
          ? new Date(Date.parse(currentTimestamp) + 1).toISOString()
          : currentTimestamp;
      const outcome = this.#database.transaction((): Outcome => {
        const current = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          id,
        );
        if (!current.ok) {
          return { kind: "failure", code: current.error.code };
        }
        const currentFormat = current.value?.formats.find(
          (candidate) => candidate.format === format,
        );
        if (
          !currentFormat ||
          currentFormat.sourcePath !== expectedCurrent.sourcePath ||
          currentFormat.addedAt !== expectedCurrent.addedAt ||
          currentFormat.provenance !== expectedCurrent.provenance
        ) {
          return { kind: "format-changed" };
        }

        const stored = this.#database!
          .query<StoredPositionedBookFormat, [string, string]>(`
            SELECT source_path AS sourcePath, format, added_at AS addedAt, provenance, position
            FROM library_item_formats
            WHERE library_item_id = ? AND format = ?
          `)
          .get(id, format);
        if (!stored) {
          return { kind: "format-changed" };
        }

        let storedSourcePath = installed?.storedPath ?? inspected.path;
        let adoptedManagedLeaf: string | null = null;
        if (!installed) {
          const revalidated = readSource(source.path);
          if (
            !revalidated ||
            revalidated.path !== inspected.path ||
            revalidated.format !== format
          ) {
            throw sourceChanged;
          }
          storedSourcePath = revalidated.path;
          adoptedManagedLeaf = managedLeafForReferencedPath(
            this.#itemsDirectory,
            revalidated.path,
            format,
          );
        } else if (
          expectedArtifact &&
          !managedFileMatchesArtifact(installed.path, expectedArtifact)
        ) {
          throw installedArtifactMismatch;
        }

        let cleanupPath: string | undefined;
        if (stored.provenance === "managed") {
          if (typeof stored.sourcePath !== "string") {
            return { kind: "failure", code: "invalid-stored-data" };
          }
          resolveManagedFormatPath(this.#itemsDirectory, stored.sourcePath, format, true);
          if (stored.sourcePath !== adoptedManagedLeaf) {
            cleanupPath = stored.sourcePath;
            this.#database!.run(
              "INSERT OR IGNORE INTO managed_file_cleanup (source_path, kind) VALUES (?, 'format')",
              [cleanupPath],
            );
          }
        }

        this.#database!.run(
          `UPDATE library_item_formats
            SET source_path = ?, added_at = ?, provenance = ?
            WHERE library_item_id = ? AND format = ?`,
          [storedSourcePath, addedAt, installed ? "managed" : "referenced", id, format],
        );
        this.#database!.run("UPDATE library_items SET updated_at = ? WHERE id = ?", [addedAt, id]);
        if (installed) {
          this.#database!.run(
            "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
            [installed.storedPath],
          );
        } else if (adoptedManagedLeaf) {
          this.#database!.run(
            "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = 'format'",
            [adoptedManagedLeaf],
          );
        }

        const replaced = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          id,
        );
        if (!replaced.ok || !replaced.value) {
          throw new TypeError("Invalid replaced library item");
        }
        return { kind: "replaced", item: replaced.value, cleanupPath };
      }).immediate();

      if (outcome.kind !== "replaced") {
        if (installed) {
          attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
            sourcePath: installed.storedPath,
            kind: "format",
          });
        }
        return failure(outcome.kind === "format-changed" ? "format-changed" : outcome.code);
      }

      const cleanupPending =
        outcome.cleanupPath === undefined
          ? false
          : !attemptOwnedFileCleanup(
              this.#database,
              this.#coversDirectory,
              this.#itemsDirectory,
              { sourcePath: outcome.cleanupPath, kind: "format" },
            );
      return success({ item: outcome.item, cleanupPending });
    } catch (error) {
      if (installed) {
        attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
          sourcePath: installed.storedPath,
          kind: "format",
        });
      }
      return failure(error === installedArtifactMismatch ? "invalid-arguments" : "storage-unavailable");
    }
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
    const parsedPatch = libraryMetadataPatchSchema.safeParse(patch);
    if (!parsedPatch.success) {
      return failure("invalid-arguments");
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

        const authors =
          parsedPatch.data.authors === null
            ? undefined
            : (parsedPatch.data.authors ?? current.value.authors);
        const author =
          parsedPatch.data.authors !== undefined
            ? authors
                ?.map(({ name }) => name.trim())
                .filter((name) => name.length > 0)
                .join(", ")
            : parsedPatch.data.author === null
              ? undefined
              : (parsedPatch.data.author ?? current.value.author);
        const updated = libraryItemSchema.safeParse({
          ...current.value,
          title: parsedPatch.data.title ?? current.value.title,
          author,
          authors,
          series:
            parsedPatch.data.series === null
              ? undefined
              : (parsedPatch.data.series ?? current.value.series),
          seriesIndex:
            parsedPatch.data.seriesIndex === null
              ? undefined
              : (parsedPatch.data.seriesIndex ?? current.value.seriesIndex),
          publisher:
            parsedPatch.data.publisher === null
              ? undefined
              : (parsedPatch.data.publisher ?? current.value.publisher),
          languages:
            parsedPatch.data.languages === null
              ? undefined
              : (parsedPatch.data.languages ?? current.value.languages),
          identifiers:
            parsedPatch.data.identifiers === null
              ? undefined
              : (parsedPatch.data.identifiers ?? current.value.identifiers),
          publishedDate:
            parsedPatch.data.publishedDate === null
              ? undefined
              : (parsedPatch.data.publishedDate ?? current.value.publishedDate),
          rating:
            parsedPatch.data.rating === null
              ? undefined
              : (parsedPatch.data.rating ?? current.value.rating),
          description:
            parsedPatch.data.description === null
              ? undefined
              : (parsedPatch.data.description ?? current.value.description),
          tags: parsedPatch.data.tags,
          updatedAt: new Date().toISOString(),
        });
        if (!updated.success) {
          return failure<LibraryItem | null>("invalid-stored-data");
        }

        this.#database!.run(
          `UPDATE library_items
            SET title = ?, author = ?, series = ?, series_index = ?,
              publisher = ?, published_date = ?, rating = ?,
              description = ?, updated_at = ?
            WHERE id = ?`,
          [
            updated.data.title,
            updated.data.author ?? null,
            updated.data.series ?? null,
            updated.data.seriesIndex ?? null,
            updated.data.publisher ?? null,
            updated.data.publishedDate ?? null,
            updated.data.rating ?? null,
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
        if (parsedPatch.data.authors !== undefined) {
          this.#database!.run("DELETE FROM library_item_authors WHERE library_item_id = ?", [id]);
          writeAuthors(this.#database!, id, updated.data.authors ?? []);
        }
        if (parsedPatch.data.languages !== undefined) {
          this.#database!.run("DELETE FROM library_item_languages WHERE library_item_id = ?", [id]);
          writeLanguages(this.#database!, id, updated.data.languages ?? []);
        }
        if (parsedPatch.data.identifiers !== undefined) {
          this.#database!.run("DELETE FROM library_item_identifiers WHERE library_item_id = ?", [id]);
          writeIdentifiers(this.#database!, id, updated.data.identifiers ?? {});
        }
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
            author, series, series_index AS seriesIndex, publisher,
            published_date AS publishedDate, rating,
            description, cover_path AS coverPath, updated_at AS updatedAt
          FROM library_items
          WHERE trashed_at IS NULL
            AND (
              title LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR author LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR description LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR EXISTS (
              SELECT 1
              FROM library_item_tags
              JOIN tags ON tags.normalized_name = library_item_tags.tag_normalized_name
              WHERE library_item_tags.library_item_id = library_items.id
                AND tags.name LIKE ? ESCAPE '\\' COLLATE NOCASE
              )
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

  async query(request: QueryLibraryItemsRequest): Promise<QueryLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }

    const parsedRequest = queryLibraryItemsRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    try {
      return this.#database.transaction((): QueryLibraryItemsResult => {
        const match = buildLibraryMatch(parsedRequest.data);
        const rows = this.#database!
          .query<StoredLibraryQueryRow, SqlParameter[]>(`
            SELECT library_items.id, library_items.title,
              library_items.added_at AS addedAt, library_items.author,
              library_items.series, library_items.series_index AS seriesIndex,
              library_items.publisher, library_items.published_date AS publishedDate,
              library_items.rating, library_items.description,
              library_items.cover_path AS coverPath, library_items.updated_at AS updatedAt,
              COUNT(*) OVER () AS total
            FROM library_items
            LEFT JOIN library_item_authors AS primary_author
              ON primary_author.library_item_id = library_items.id
              AND primary_author.position = 0
            WHERE ${match.sql}
            ORDER BY ${buildLibraryOrder(parsedRequest.data)}
            LIMIT ? OFFSET ?
          `)
          .all(...match.parameters, parsedRequest.data.page.limit, parsedRequest.data.page.offset);
        const total =
          rows[0]?.total ??
          this.#database!
            .query<{ total: unknown }, SqlParameter[]>(`
              SELECT COUNT(*) AS total
              FROM library_items
              WHERE ${match.sql}
            `)
            .get(...match.parameters)?.total;
        const facetQuery = buildFacetQuery(parsedRequest.data);
        const facetRows = this.#database!
          .query<StoredFacetRow, SqlParameter[]>(facetQuery.sql)
          .all(...facetQuery.parameters);
        const items = hydrateLibraryPage(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          rows,
        );
        if (!items.ok) {
          return items;
        }

        const facets: Record<LibraryFacet, { value: unknown; count: unknown }[]> = {
          authors: [],
          tags: [],
          series: [],
          languages: [],
          formats: [],
        };
        for (const row of facetRows) {
          if (typeof row.facet !== "string" || !(row.facet in facets)) {
            return failure("invalid-stored-data");
          }
          facets[row.facet as LibraryFacet].push({ value: row.value, count: row.count });
        }

        const page = libraryQueryPageSchema.safeParse({
          items: items.value,
          total,
          page: parsedRequest.data.page,
          facets,
        });
        return page.success ? success(page.data) : failure("invalid-stored-data");
      })();
    } catch {
      return failure("storage-unavailable");
    }
  }

  async listSavedViews(
    request: ListSavedLibraryViewsRequest,
  ): Promise<ListSavedLibraryViewsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    if (!listSavedLibraryViewsRequestSchema.safeParse(request).success) {
      return failure("invalid-arguments");
    }

    try {
      const rows = this.#database
        .query<StoredSavedLibraryView, []>(`
          SELECT id, name, definition_json AS definitionJson,
            created_at AS createdAt, updated_at AS updatedAt
          FROM saved_library_views
          ORDER BY name COLLATE NOCASE, id
        `)
        .all();
      const views: SavedLibraryView[] = [];
      for (const row of rows) {
        const view = parseSavedLibraryView(row);
        if (!view.ok) {
          return view;
        }
        views.push(view.value);
      }
      return success(views);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async saveSavedView(
    request: SaveSavedLibraryViewRequest,
  ): Promise<SaveSavedLibraryViewResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = saveSavedLibraryViewRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    try {
      return this.#database.transaction((): SaveSavedLibraryViewResult => {
        const now = new Date().toISOString();
        const row = this.#database!
          .query<StoredSavedLibraryView, [string, string, string, string, string]>(`
            INSERT INTO saved_library_views
              (id, name, definition_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              definition_json = excluded.definition_json,
              updated_at = excluded.updated_at
            RETURNING id, name, definition_json AS definitionJson,
              created_at AS createdAt, updated_at AS updatedAt
          `)
          .get(
            parsedRequest.data.id,
            parsedRequest.data.name,
            JSON.stringify(parsedRequest.data.definition),
            now,
            now,
          );
        return row ? parseSavedLibraryView(row) : failure("storage-unavailable");
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  async removeSavedView(
    request: RemoveSavedLibraryViewRequest,
  ): Promise<RemoveSavedLibraryViewResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = removeSavedLibraryViewRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    try {
      return this.#database.transaction((): RemoveSavedLibraryViewResult => {
        const row = this.#database!
          .query<StoredSavedLibraryView, [string]>(`
            SELECT id, name, definition_json AS definitionJson,
              created_at AS createdAt, updated_at AS updatedAt
            FROM saved_library_views
            WHERE id = ?
          `)
          .get(parsedRequest.data.id);
        if (!row) {
          return success(null);
        }
        const parsed = parseSavedLibraryView(row);
        if (!parsed.ok) {
          return parsed;
        }
        this.#database!.run("DELETE FROM saved_library_views WHERE id = ?", [
          parsedRequest.data.id,
        ]);
        return success(parsed.value);
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  #deleteItem(id: string, requireTrashed: boolean): RemoveLibraryItemResult {
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
          .query<StoredTrashLibraryItem, [string]>(`
            SELECT id, title, added_at AS addedAt,
              author, series, series_index AS seriesIndex, publisher,
              published_date AS publishedDate, rating,
              description, cover_path AS coverPath, updated_at AS updatedAt,
              trashed_at AS trashedAt
            FROM library_items
            WHERE id = ?
          `)
          .get(id);
        if (!row) {
          return { kind: "missing" };
        }
        if (row.trashedAt !== null && !isStoredTrashTimestamp(row.trashedAt)) {
          return { kind: "failure", code: "invalid-stored-data" };
        }
        if (requireTrashed && row.trashedAt === null) {
          return { kind: "failure", code: "not-trashed" };
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

  async remove({ id }: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult> {
    return this.#deleteItem(id, false);
  }

  async purge(request: PurgeLibraryItemRequest): Promise<PurgeLibraryItemResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = purgeLibraryItemRequestSchema.safeParse(request);
    return parsedRequest.success
      ? this.#deleteItem(parsedRequest.data.id, true)
      : failure("invalid-arguments");
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }
}
