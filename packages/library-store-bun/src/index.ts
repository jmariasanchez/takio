import {
  bookCustomMetadataSchema,
  bookFormatSchema,
  bookFormatsSchema,
  detectFormat,
  FORMAT_CATALOG,
  FORMAT_IDS,
  libraryItemSchema,
  sanitizeDestinationFileName,
  type BookFormatProvenance,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import {
  duplicateCandidatePageSchema,
  exportLibraryItemsRequestSchema,
  keepDuplicatePairRequestSchema,
  listDuplicateCandidatesRequestSchema,
  libraryMetadataPatchSchema,
  importLibraryItemsRequestSchema,
  libraryQueryPageSchema,
  libraryTrashPageSchema,
  listLibraryTrashRequestSchema,
  listSavedLibraryViewsRequestSchema,
  METADATA_CANDIDATE_AUDIT_KEY,
  mergeDuplicatePairRequestSchema,
  purgeLibraryItemRequestSchema,
  queryLibraryItemsRequestSchema,
  replaceLibraryFormatRequestSchema,
  removeSavedLibraryViewRequestSchema,
  reopenDuplicatePairRequestSchema,
  restoreLibraryItemRequestSchema,
  savedLibraryViewSchema,
  saveSavedLibraryViewRequestSchema,
  trashLibraryItemRequestSchema,
} from "@takio/library-contract";
import type {
  AddLibraryItemRequest,
  AddLibraryItemResult,
  AdoptLibraryItemRequest,
  AdoptLibraryItemResult,
  AttachLibraryFormatRequest,
  AttachLibraryFormatResult,
  DuplicateCandidate,
  DuplicateSignal,
  GetLibraryItemRequest,
  GetLibraryItemResult,
  ImportLibraryItemRequest,
  ImportLibraryItemResult,
  ImportLibraryItemsRequest,
  ImportLibraryItemsResult,
  ExportLibraryItemsRequest,
  ExportLibraryItemsResult,
  KeepDuplicatePairRequest,
  KeepDuplicatePairResult,
  LibraryBatchImportStore,
  LibraryAdoptionStore,
  LibraryDuplicateReviewStore,
  LibraryExportEntryOutcome,
  LibraryExportStore,
  LibraryImportEntryOutcome,
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
  ListDuplicateCandidatesRequest,
  ListDuplicateCandidatesResult,
  MergeDuplicatePairRequest,
  MergeDuplicatePairResult,
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
  ReopenDuplicatePairRequest,
  ReopenDuplicatePairResult,
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
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { initializationTestSeam } from "./initialization-test-seam.js";
import { lifecycleTestSeam } from "./lifecycle-test-seam.js";
import { queryTestSeam } from "./query-test-seam.js";

export const LIBRARY_SCHEMA_VERSION = 10;
const SCHEMA_VERSION = LIBRARY_SCHEMA_VERSION;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const incompatibleSchema = Symbol("incompatible-schema");
const duplicateFormat = Symbol("duplicate-format");
const sourceChanged = Symbol("source-changed");
const installedArtifactMismatch = Symbol("installed-artifact-mismatch");
const duplicateMergeRollback = Symbol("duplicate-merge-rollback");
const invalidStoredExport = Symbol("invalid-stored-export");
const formatIdSqlList = FORMAT_IDS.map((format) => `'${format}'`).join(", ");

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
type StoredFingerprint = { contentBytes: unknown; contentSha256: unknown };
type StoredV7BookFormat = StoredBookFormat & StoredFingerprint;
type StoredPositionedBookFormat = StoredBookFormat & { position: unknown };
type StoredPositionedV3BookFormat = StoredV3BookFormat & { position: unknown };
type StoredTag = { name: unknown };
type StoredAuthor = { name: unknown; sortName: unknown; position: unknown };
type StoredLanguage = { language: unknown; position: unknown };
type StoredIdentifier = { scheme: unknown; value: unknown };
type StoredCustomMetadata = { name: unknown; value: unknown };
type StoredSourceCleanup = {
  sourcePath: string;
  contentBytes: number;
  contentSha256: string;
};
type StoredItemFormat = StoredPositionedBookFormat & { libraryItemId: string };
type StoredItemTag = StoredTag & { libraryItemId: string; position: unknown };
type StoredItemAuthor = StoredAuthor & { libraryItemId: string };
type StoredItemLanguage = StoredLanguage & { libraryItemId: string };
type StoredItemIdentifier = StoredIdentifier & { libraryItemId: string };
type StoredItemCustomMetadata = StoredCustomMetadata & { libraryItemId: string };
type StoredMigrationFormat = {
  libraryItemId: string;
  sourcePath: string;
  format: string;
  addedAt: string;
  provenance: string;
  position: number;
};
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
type FingerprintFailure = "unreadable" | "source-changed";
type BatchImportFailure =
  | FingerprintFailure
  | "not-found"
  | "storage-unavailable"
  | "cross-device-move"
  | "invalid-title";

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

function isStoredManagedFingerprint(value: unknown): value is ExpectedArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function fingerprintFile(
  path: string,
  expected?: ReturnType<typeof lstatSync>,
): { ok: true; value: ExpectedArtifact } | { ok: false; code: FingerprintFailure } {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      (expected !== undefined &&
        (expected.isSymbolicLink() ||
          !expected.isFile() ||
          expected.dev !== before.dev ||
          expected.ino !== before.ino ||
          expected.size !== before.size ||
          expected.mtimeMs !== before.mtimeMs ||
          expected.ctimeMs !== before.ctimeMs))
    ) {
      return { ok: false, code: "source-changed" };
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
      hash.update(buffer.subarray(0, read));
    }

    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !after.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      after.ctimeMs !== current.ctimeMs ||
      bytes !== after.size
    ) {
      return { ok: false, code: "source-changed" };
    }
    return { ok: true, value: { bytes, sha256: hash.digest("hex") } };
  } catch (error) {
    return {
      ok: false,
      code:
        expected !== undefined &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
          ? "source-changed"
          : "unreadable",
    };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

const MAX_EXPORT_FILE_NAME_BYTES = 240;

type ExportCopyResult =
  | { status: "exported"; bytes: number; sha256: string }
  | { status: "skipped" }
  | {
      status: "failed";
      code: "source-unavailable" | "source-changed" | "destination-unavailable";
    };

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameFile(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function exportFileName(
  title: string,
  author: string | null,
  template: ExportLibraryItemsRequest["fileNameTemplate"],
  itemId: string,
  format: FormatId,
): string {
  const extension = FORMAT_CATALOG.find(({ id }) => id === format)!.extensions[0]!;
  const identity = createHash("sha256").update(itemId).digest("hex");
  const suffix = ` [${identity}]${extension}`;
  const sanitizeStem = (value: string, fallback: string): string =>
    sanitizeDestinationFileName(value.normalize("NFC"))
      ?.trim()
      .replace(/[. ]+$/u, "") || fallback;
  const stemSource =
    template === "author-title"
      ? `${sanitizeStem(author ?? "Unknown author", "Unknown author")} - ${sanitizeStem(title, "Untitled")}`
      : title;
  const sanitized = sanitizeDestinationFileName(stemSource.normalize("NFC"))
    ?.trim()
    .replace(/[. ]+$/u, "");
  const stem = truncateUtf8(
    sanitized || "Untitled",
    MAX_EXPORT_FILE_NAME_BYTES - Buffer.byteLength(suffix),
  ).replace(/[. ]+$/u, "");
  return `${stem || "Untitled"}${suffix}`;
}

function exportDirectorySegment(value: string | null, fallback: string): string {
  const segment =
    sanitizeDestinationFileName((value ?? fallback).normalize("NFC").replace(/[\\/]/g, ""))
      ?.trim()
      .replace(/[. ]+$/u, "") || fallback;
  return truncateUtf8(segment, 128).replace(/[. ]+$/u, "") || fallback;
}

function requestedExportDirectory(
  destinationDirectory: string,
  template: ExportLibraryItemsRequest["directoryTemplate"],
  author: string | null,
  series: string | null,
): string {
  if (template === undefined || template === "flat") {
    return destinationDirectory;
  }
  const segment =
    template === "author"
      ? exportDirectorySegment(author, "Unknown author")
      : exportDirectorySegment(series, "Unsorted");
  return join(destinationDirectory, segment);
}

function prepareExportDirectory(
  destinationDirectory: string,
  requestedDirectory: string,
): string | null {
  if (requestedDirectory === destinationDirectory) {
    return destinationDirectory;
  }
  try {
    const metadata = lstatSync(requestedDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return null;
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return null;
    }
    try {
      mkdirSync(requestedDirectory);
    } catch {
      return null;
    }
  }
  try {
    const canonical = realpathSync(requestedDirectory);
    return isInside(destinationDirectory, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function copyExportFile(sourcePath: string, destinationPath: string): ExportCopyResult {
  try {
    lstatSync(destinationPath);
    return { status: "skipped" };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return { status: "failed", code: "destination-unavailable" };
    }
  }

  let source: number | undefined;
  let canonicalSourcePath: string;
  try {
    canonicalSourcePath = realpathSync(sourcePath);
    source = openSync(canonicalSourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { status: "failed", code: "source-unavailable" };
  }

  let partial: number | undefined;
  let partialPath: string | undefined;
  try {
    const sourceBefore = fstatSync(source);
    if (!sourceBefore.isFile() || sourceBefore.size <= 0) {
      return { status: "failed", code: "source-unavailable" };
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = join(dirname(destinationPath), `.takio-export-${randomUUID()}.partial`);
      try {
        partial = openSync(
          candidate,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        partialPath = candidate;
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          return { status: "failed", code: "destination-unavailable" };
        }
      }
    }
    if (partial === undefined || partialPath === undefined) {
      return { status: "failed", code: "destination-unavailable" };
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      let read: number;
      try {
        read = readSync(source, buffer, 0, buffer.length, null);
      } catch {
        return { status: "failed", code: "source-unavailable" };
      }
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
      bytes += read;
      let written = 0;
      try {
        while (written < read) {
          const count = writeSync(partial, buffer, written, read - written);
          if (count === 0) {
            return { status: "failed", code: "destination-unavailable" };
          }
          written += count;
        }
      } catch {
        return { status: "failed", code: "destination-unavailable" };
      }
    }

    let sourceAfter: ReturnType<typeof fstatSync>;
    let sourceCurrent: ReturnType<typeof lstatSync>;
    try {
      sourceAfter = fstatSync(source);
      sourceCurrent = lstatSync(canonicalSourcePath);
    } catch {
      return { status: "failed", code: "source-changed" };
    }
    if (
      !sameFile(sourceBefore, sourceAfter) ||
      !sameFile(sourceAfter, sourceCurrent) ||
      sourceCurrent.isSymbolicLink() ||
      bytes !== sourceAfter.size
    ) {
      return { status: "failed", code: "source-changed" };
    }

    const sha256 = hash.digest("hex");
    try {
      fsyncSync(partial);
      closeSync(partial);
      partial = undefined;
      const verification = fingerprintFile(partialPath);
      if (
        !verification.ok ||
        verification.value.bytes !== bytes ||
        verification.value.sha256 !== sha256
      ) {
        return { status: "failed", code: "destination-unavailable" };
      }
      linkSync(partialPath, destinationPath);
      const directory = openSync(dirname(destinationPath), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      return hasErrorCode(error, "EEXIST")
        ? { status: "skipped" }
        : { status: "failed", code: "destination-unavailable" };
    }
    return { status: "exported", bytes, sha256 };
  } catch {
    return { status: "failed", code: "source-unavailable" };
  } finally {
    if (partial !== undefined) {
      closeSync(partial);
    }
    if (source !== undefined) {
      closeSync(source);
    }
    if (partialPath !== undefined) {
      try {
        unlinkSync(partialPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          // The exported target is independent of best-effort partial cleanup.
        }
      }
    }
  }
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

function storedFormatUsesPath(database: Database, path: string, storedPath: string): boolean {
  const formats = database
    .query<{ sourcePath: unknown; provenance: unknown }, []>(`
      SELECT source_path AS sourcePath, provenance
      FROM library_item_formats
    `)
    .all();
  for (const row of formats) {
    if (row.provenance === "managed" && row.sourcePath === storedPath) {
      return true;
    }
    if (
      row.provenance !== "referenced" ||
      typeof row.sourcePath !== "string" ||
      !isAbsolute(row.sourcePath)
    ) {
      continue;
    }
    try {
      if (realpathSync(row.sourcePath) === realpathSync(path)) {
        return true;
      }
    } catch {
      // An unreadable reference cannot retain this managed file.
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
    const stillUsed =
      kind === "format"
        ? existsSync(path) && storedFormatUsesPath(database, path, sourcePath)
        : Boolean(
            database
              .query<{ present: number }, [string]>(
                "SELECT 1 AS present FROM library_items WHERE cover_path = ? LIMIT 1",
              )
              .get(sourcePath),
          );
    if (stillUsed) {
      database.run(
        "DELETE FROM managed_file_cleanup WHERE source_path = ? AND kind = ?",
        [sourcePath, kind],
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

type StoredAdoption = {
  id: string;
  libraryItemId: string;
  title: string;
  sourcePath: string;
  targetPath: string;
  format: FormatId;
  contentBytes: number;
  contentSha256: string;
  state: "pending-rename" | "renamed" | "finalizing";
};

function fsyncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function adoptionMatches(path: string, adoption: StoredAdoption): boolean {
  const fingerprint = fingerprintFile(path);
  return (
    fingerprint.ok &&
    fingerprint.value.bytes === adoption.contentBytes &&
    fingerprint.value.sha256 === adoption.contentSha256
  );
}

function sameDeviceAdoptionPreflight(sourcePath: string, itemsDirectory: string): boolean {
  const seam = lifecycleTestSeam.sameDevicePreflight?.(sourcePath, itemsDirectory);
  if (seam !== undefined) return seam;
  return statSync(sourcePath).dev === statSync(itemsDirectory).dev;
}

function finalizeAdoption(database: Database, itemsDirectory: string, adoption: StoredAdoption): LibraryItem {
  if (!adoptionMatches(adoption.targetPath, adoption)) throw installedArtifactMismatch;
  const existing = readStoredItem(database, "", itemsDirectory, adoption.libraryItemId);
  if (existing.ok && existing.value) {
    database.run("DELETE FROM library_adoptions WHERE id = ?", [adoption.id]);
    return existing.value;
  }
  const addedAt = new Date().toISOString();
  if (adoption.state !== "finalizing") {
    database.run("UPDATE library_adoptions SET state = 'finalizing', updated_at = ? WHERE id = ?", [
      addedAt,
      adoption.id,
    ]);
  }
  lifecycleTestSeam.afterAdoptionFinalizing?.();
  database.transaction(() => {
    database.run(
      `INSERT INTO library_items
        (id, title, added_at, author, description, cover_path, updated_at)
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
      [adoption.libraryItemId, adoption.title, addedAt],
    );
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position,
          content_bytes, content_sha256)
        VALUES (?, ?, ?, ?, 'managed', 0, ?, ?)`,
      [
        adoption.libraryItemId,
        adoption.format,
        basename(adoption.targetPath),
        addedAt,
        adoption.contentBytes,
        adoption.contentSha256,
      ],
    );
    database.run("DELETE FROM library_adoptions WHERE id = ?", [adoption.id]);
  }).immediate();
  const item = readStoredItem(database, "", itemsDirectory, adoption.libraryItemId);
  if (!item.ok || !item.value) throw invalidStoredExport;
  return item.value;
}

function recoverLibraryAdoptions(database: Database, itemsDirectory: string): void {
  const rows = database
    .query<{
      id: string;
      libraryItemId: string;
      title: string;
      sourcePath: string;
      targetPath: string;
      format: unknown;
      contentBytes: number;
      contentSha256: string;
      state: StoredAdoption["state"];
    }, []>(`
      SELECT id, library_item_id AS libraryItemId, title, source_path AS sourcePath,
        target_path AS targetPath, format, content_bytes AS contentBytes,
        content_sha256 AS contentSha256, state
      FROM library_adoptions
      ORDER BY updated_at, id
    `)
    .all();
  for (const row of rows) {
    if (!FORMAT_IDS.includes(row.format as FormatId)) continue;
    const adoption = { ...row, format: row.format as FormatId };
    if (adoption.state === "pending-rename") {
      if (existsSync(adoption.targetPath)) {
        if (!adoptionMatches(adoption.targetPath, adoption)) continue;
      } else {
        if (!adoptionMatches(adoption.sourcePath, adoption)) continue;
        renameSync(adoption.sourcePath, adoption.targetPath);
        fsyncPath(adoption.targetPath);
        fsyncDirectory(itemsDirectory);
        const sourceDirectory = dirname(adoption.sourcePath);
        if (sourceDirectory !== itemsDirectory) fsyncDirectory(sourceDirectory);
      }
      database.run("UPDATE library_adoptions SET state = 'renamed', updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        adoption.id,
      ]);
    }
    finalizeAdoption(database, itemsDirectory, adoption);
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
  customMetadata?: unknown;
};

function readRichMetadata(
  database: Database,
  itemId: string,
  includeCustomMetadata = true,
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

  const customMetadataEntries: [string, unknown][] = [];
  if (includeCustomMetadata) {
    const storedCustomMetadata = database
      .query<StoredCustomMetadata, [string]>(`
        SELECT name, value
        FROM library_item_custom_metadata
        WHERE library_item_id = ?
        ORDER BY name
      `)
      .all(itemId);
    customMetadataEntries.push(
      ...storedCustomMetadata.map(
        ({ name, value }): [string, unknown] => [name as string, value],
      ),
    );
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
    customMetadata:
      customMetadataEntries.length === 0
        ? undefined
        : Object.fromEntries(customMetadataEntries),
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
  includeCustomMetadata = true,
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

  const richMetadata = includeRichMetadata
    ? readRichMetadata(database, row.id, includeCustomMetadata)
    : success({});
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

function createCustomMetadataTable(database: Database): void {
  database.run(`
    CREATE TABLE library_item_custom_metadata (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (library_item_id, name)
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

function createV4FormatTable(database: Database): void {
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

function createFormatTable(database: Database): void {
  database.run(`
    CREATE TABLE library_item_formats (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      source_path TEXT NOT NULL,
      added_at TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('managed', 'referenced')),
      position INTEGER NOT NULL CHECK (position >= 0),
      content_bytes INTEGER,
      content_sha256 TEXT,
      CHECK (
        (provenance = 'managed'
          AND content_bytes IS NOT NULL
          AND content_bytes >= 0
          AND content_sha256 IS NOT NULL
          AND length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^0-9a-f]*')
        OR
        (provenance = 'referenced' AND content_bytes IS NULL AND content_sha256 IS NULL)
      ),
      PRIMARY KEY (library_item_id, format),
      UNIQUE (library_item_id, position)
    ) STRICT
  `);
}

function createManagedFingerprintIndex(database: Database): void {
  database.run(`
    CREATE INDEX library_item_formats_by_fingerprint
    ON library_item_formats(content_bytes, content_sha256, library_item_id, position)
    WHERE provenance = 'managed'
  `);
}

function createDuplicatePairReviewsTable(database: Database): void {
  database.run(`
    CREATE TABLE duplicate_pair_reviews (
      left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      review_token TEXT NOT NULL CHECK (
        length(review_token) = 64 AND review_token NOT GLOB '*[^0-9a-f]*'
      ),
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (left_id, right_id)
    ) STRICT
  `);
}

function createLibraryAdoptionsTable(database: Database): void {
  database.run(`
    CREATE TABLE library_adoptions (
      id TEXT PRIMARY KEY CHECK (length(id) > 0),
      library_item_id TEXT NOT NULL UNIQUE CHECK (length(library_item_id) > 0),
      title TEXT NOT NULL CHECK (length(title) > 0),
      source_path TEXT NOT NULL CHECK (length(source_path) > 0),
      target_path TEXT NOT NULL UNIQUE CHECK (length(target_path) > 0),
      format TEXT NOT NULL CHECK (format IN (${formatIdSqlList})),
      content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
      content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      state TEXT NOT NULL CHECK (state IN ('pending-rename', 'renamed', 'finalizing')),
      created_at TEXT NOT NULL CHECK (length(created_at) > 0),
      updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
      CHECK (source_path <> target_path)
    ) STRICT
  `);
  database.run(`
    CREATE INDEX library_adoptions_by_state
    ON library_adoptions(state, updated_at, id)
  `);
}

function migrateV9ToV10(database: Database): void {
  createLibraryAdoptionsTable(database);
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

function ensureSourceCleanupTable(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS source_file_cleanup (
      source_path TEXT PRIMARY KEY,
      content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
      content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ) STRICT
  `);
}

function sourceCleanupPending(
  database: Database,
  sourcePath: string,
  artifact: ExpectedArtifact,
): boolean {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(sourcePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      database.run("DELETE FROM source_file_cleanup WHERE source_path = ?", [sourcePath]);
      return false;
    }
    return true;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return true;
  try {
    lifecycleTestSeam.beforeSourceFileCleanup?.(sourcePath);
  } catch {
    return true;
  }
  try {
    entry = lstatSync(sourcePath);
  } catch {
    return true;
  }
  if (entry.isSymbolicLink() || !entry.isFile()) return true;
  const current = fingerprintFile(sourcePath, entry);
  if (
    !current.ok ||
    current.value.bytes !== artifact.bytes ||
    current.value.sha256 !== artifact.sha256
  ) {
    return true;
  }
  try {
    unlinkSync(sourcePath);
    database.run("DELETE FROM source_file_cleanup WHERE source_path = ?", [sourcePath]);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      database.run("DELETE FROM source_file_cleanup WHERE source_path = ?", [sourcePath]);
      return false;
    }
    return true;
  }
}

function queueSourceFileCleanup(
  database: Database,
  sourcePath: string,
  artifact: ExpectedArtifact,
): boolean {
  database.run(
    `INSERT INTO source_file_cleanup (source_path, content_bytes, content_sha256)
      VALUES (?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        content_bytes = excluded.content_bytes,
        content_sha256 = excluded.content_sha256`,
    [sourcePath, artifact.bytes, artifact.sha256],
  );
  return sourceCleanupPending(database, sourcePath, artifact);
}

function retrySourceFileCleanup(database: Database): void {
  const pending = database
    .query<StoredSourceCleanup, []>(`
      SELECT source_path AS sourcePath, content_bytes AS contentBytes,
        content_sha256 AS contentSha256
      FROM source_file_cleanup
      ORDER BY source_path
    `)
    .all();
  for (const row of pending) {
    sourceCleanupPending(database, row.sourcePath, {
      bytes: row.contentBytes,
      sha256: row.contentSha256,
    });
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
  createV4FormatTable(database);
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

function migrateV6ToV7(database: Database, itemsDirectory: string): void {
  const rows = database
    .query<StoredMigrationFormat, []>(`
      SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
        format, added_at AS addedAt, provenance, position
      FROM library_item_formats
      ORDER BY library_item_id, position
    `)
    .all();
  const fingerprints = new Map<string, ExpectedArtifact>();
  for (const row of rows) {
    if (row.provenance !== "managed") {
      continue;
    }
    const format = bookFormatSchema.safeParse({
      sourcePath: row.sourcePath,
      format: row.format,
      addedAt: row.addedAt,
      provenance: row.provenance,
    });
    if (!format.success || format.data.provenance !== "managed") {
      throw new TypeError("Invalid managed format during migration");
    }
    const path = resolveManagedFormatPath(
      itemsDirectory,
      format.data.sourcePath,
      format.data.format,
      true,
    );
    const fingerprint = fingerprintFile(path);
    if (!fingerprint.ok) {
      throw new TypeError("Managed format could not be fingerprinted during migration");
    }
    fingerprints.set(`${row.libraryItemId}\0${row.format}`, fingerprint.value);
  }

  database.run("ALTER TABLE library_item_formats RENAME TO library_item_formats_v6");
  createFormatTable(database);
  for (const row of rows) {
    const fingerprint = fingerprints.get(`${row.libraryItemId}\0${row.format}`);
    database.run(
      `INSERT INTO library_item_formats
        (library_item_id, format, source_path, added_at, provenance, position,
          content_bytes, content_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.libraryItemId,
        row.format,
        row.sourcePath,
        row.addedAt,
        row.provenance,
        row.position,
        fingerprint?.bytes ?? null,
        fingerprint?.sha256 ?? null,
      ],
    );
  }
  database.run("DROP TABLE library_item_formats_v6");
  database.run(
    `CREATE INDEX library_item_formats_by_format
      ON library_item_formats(format, library_item_id)`,
  );
  createManagedFingerprintIndex(database);
}

function migrateV7ToV8(database: Database): void {
  createDuplicatePairReviewsTable(database);
}

function migrateV8ToV9(database: Database): void {
  createCustomMetadataTable(database);
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
    rows.some((row) => !readItem(database, coversDirectory, itemsDirectory, row, true, false).ok)
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

function verifyV6Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  if (version !== 6) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV6Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV6Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v6.backup`, (path) =>
    verifyV6Backup(path, coversDirectory, itemsDirectory),
  );
}

function verifyV7Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  verifyV6Database(database, coversDirectory, itemsDirectory);
  const formats = database
    .query<StoredV7BookFormat & { libraryItemId: string }, []>(`
      SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
        format, added_at AS addedAt, provenance,
        content_bytes AS contentBytes, content_sha256 AS contentSha256
      FROM library_item_formats
      ORDER BY library_item_id, position
    `)
    .all();
  for (const row of formats) {
    if (row.provenance === "referenced") {
      if (row.contentBytes !== null || row.contentSha256 !== null) {
        throw new Error("The migrated database could not be verified.");
      }
      continue;
    }
    if (
      row.provenance !== "managed" ||
      typeof row.contentBytes !== "number" ||
      !Number.isSafeInteger(row.contentBytes) ||
      row.contentBytes < 0 ||
      typeof row.contentSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.contentSha256)
    ) {
      throw new Error("The migrated database could not be verified.");
    }
    const format = bookFormatSchema.safeParse({
      sourcePath: row.sourcePath,
      format: row.format,
      addedAt: row.addedAt,
      provenance: row.provenance,
    });
    if (!format.success || format.data.provenance !== "managed") {
      throw new Error("The migrated database could not be verified.");
    }
    const path = resolveManagedFormatPath(
      itemsDirectory,
      format.data.sourcePath,
      format.data.format,
      true,
    );
    if (
      !managedFileMatchesArtifact(path, {
        bytes: row.contentBytes,
        sha256: row.contentSha256,
      })
    ) {
      throw new Error("The migrated database could not be verified.");
    }
  }
}

function verifyV7Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  if (version !== 7) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV7Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV7Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v7.backup`, (path) =>
    verifyV7Backup(path, coversDirectory, itemsDirectory),
  );
}

function verifyV8Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  verifyV7Database(database, coversDirectory, itemsDirectory);
  const reviews = database
    .query<{ leftId: unknown; rightId: unknown; reviewToken: unknown; reviewedAt: unknown }, []>(`
      SELECT left_id AS leftId, right_id AS rightId,
        review_token AS reviewToken, reviewed_at AS reviewedAt
      FROM duplicate_pair_reviews
      ORDER BY left_id, right_id
    `)
    .all();
  if (
    reviews.some(
      ({ leftId, rightId, reviewToken, reviewedAt }) =>
        typeof leftId !== "string" ||
        typeof rightId !== "string" ||
        leftId >= rightId ||
        typeof reviewToken !== "string" ||
        !/^[0-9a-f]{64}$/.test(reviewToken) ||
        !isStoredTrashTimestamp(reviewedAt),
    )
  ) {
    throw new Error("The migrated database could not be verified.");
  }
}

function verifyV8Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  if (version !== 8) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV8Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV8Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v8.backup`, (path) =>
    verifyV8Backup(path, coversDirectory, itemsDirectory),
  );
}

function verifyV9Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  verifyV8Database(database, coversDirectory, itemsDirectory);
  const rows = database
    .query<StoredItemCustomMetadata, []>(`
      SELECT library_item_id AS libraryItemId, name, value
      FROM library_item_custom_metadata
      ORDER BY library_item_id, name
    `)
    .all();
  const metadataByItem = new Map<string, Record<string, unknown>>();
  for (const { libraryItemId, name, value } of rows) {
    if (typeof libraryItemId !== "string" || typeof name !== "string") {
      throw new Error("The migrated database could not be verified.");
    }
    const metadata = metadataByItem.get(libraryItemId) ?? {};
    metadata[name] = value;
    metadataByItem.set(libraryItemId, metadata);
  }
  if ([...metadataByItem.values()].some((metadata) => !bookCustomMetadataSchema.safeParse(metadata).success)) {
    throw new Error("The migrated database could not be verified.");
  }
}

function verifyV9Backup(
  path: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  using backup = new Database(path, { strict: true });
  backup.run("PRAGMA foreign_keys = ON");
  const version = backup.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
  if (version !== 9) {
    throw new Error("The pre-migration backup could not be verified.");
  }
  verifyV9Database(backup, coversDirectory, itemsDirectory);
}

function retainVerifiedV9Backup(
  database: Database,
  databasePath: string,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  retainVerifiedBackup(database, `${databasePath}.v9.backup`, (path) =>
    verifyV9Backup(path, coversDirectory, itemsDirectory),
  );
}

function verifyV10Database(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): void {
  verifyV9Database(database, coversDirectory, itemsDirectory);
  const adoptions = database
    .query<
      {
        id: unknown;
        libraryItemId: unknown;
        title: unknown;
        sourcePath: unknown;
        targetPath: unknown;
        format: unknown;
        contentBytes: unknown;
        contentSha256: unknown;
        state: unknown;
        createdAt: unknown;
        updatedAt: unknown;
      },
      []
    >(`
      SELECT id, library_item_id AS libraryItemId, title,
        source_path AS sourcePath, target_path AS targetPath, format,
        content_bytes AS contentBytes, content_sha256 AS contentSha256,
        state, created_at AS createdAt, updated_at AS updatedAt
      FROM library_adoptions
      ORDER BY id
    `)
    .all();
  if (
    adoptions.some(
      (row) =>
        typeof row.id !== "string" ||
        row.id.length === 0 ||
        typeof row.libraryItemId !== "string" ||
        row.libraryItemId.length === 0 ||
        typeof row.title !== "string" ||
        row.title.length === 0 ||
        typeof row.sourcePath !== "string" ||
        row.sourcePath.length === 0 ||
        typeof row.targetPath !== "string" ||
        row.targetPath.length === 0 ||
        row.sourcePath === row.targetPath ||
        typeof row.format !== "string" ||
        !FORMAT_IDS.includes(row.format as FormatId) ||
        typeof row.contentBytes !== "number" ||
        !Number.isSafeInteger(row.contentBytes) ||
        row.contentBytes < 0 ||
        typeof row.contentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.contentSha256) ||
        (row.state !== "pending-rename" && row.state !== "renamed" && row.state !== "finalizing") ||
        typeof row.createdAt !== "string" ||
        row.createdAt.length === 0 ||
        typeof row.updatedAt !== "string" ||
        row.updatedAt.length === 0,
    )
  ) {
    throw new Error("The migrated database could not be verified.");
  }
}

export type LibraryIntegrityReport = {
  readonly schemaVersion: number;
  readonly items: {
    readonly total: number;
    readonly active: number;
    readonly trashed: number;
  };
  readonly formats: {
    readonly total: number;
    readonly managed: number;
    readonly referenced: number;
  };
};

export type LibraryIntegrityResult =
  | { readonly ok: true; readonly value: LibraryIntegrityReport }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "storage-unavailable" | "incompatible-schema" | "integrity-failed";
      };
    };

/** Verifies the current library schema and owned artifacts without migrating or repairing it. */
export function verifyLibraryIntegrity(databasePath: string): LibraryIntegrityResult {
  if (databasePath.length === 0) {
    return { ok: false, error: { code: "storage-unavailable" } };
  }

  const resolvedDatabasePath = resolve(databasePath);
  const libraryRoot = dirname(resolvedDatabasePath);
  let database: Database | null = null;
  try {
    database = new Database(resolvedDatabasePath, { readonly: true, strict: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA foreign_keys = ON");
  } catch {
    database?.close();
    return { ok: false, error: { code: "storage-unavailable" } };
  }

  try {
    const schemaVersion = database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, error: { code: "incompatible-schema" } };
    }

    verifyV10Database(database, join(libraryRoot, "covers"), join(libraryRoot, "items"));
    const itemCounts = database
      .query<{ total: number; active: number; trashed: number }, []>(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN trashed_at IS NULL THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN trashed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trashed
        FROM library_items
      `)
      .get();
    const formatCounts = database
      .query<{ total: number; managed: number; referenced: number }, []>(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN provenance = 'managed' THEN 1 ELSE 0 END), 0) AS managed,
          COALESCE(SUM(CASE WHEN provenance = 'referenced' THEN 1 ELSE 0 END), 0) AS referenced
        FROM library_item_formats
      `)
      .get();
    if (!itemCounts || !formatCounts) {
      return { ok: false, error: { code: "integrity-failed" } };
    }

    return {
      ok: true,
      value: {
        schemaVersion,
        items: {
          total: itemCounts.total,
          active: itemCounts.active,
          trashed: itemCounts.trashed,
        },
        formats: {
          total: formatCounts.total,
          managed: formatCounts.managed,
          referenced: formatCounts.referenced,
        },
      },
    };
  } catch {
    return { ok: false, error: { code: "integrity-failed" } };
  } finally {
    database.close();
  }
}

const LIBRARY_BACKUP_FORMAT = "takio-library-backup";
export const LIBRARY_BACKUP_VERSION = 1;
const MAX_LIBRARY_BACKUP_MANIFEST_BYTES = 2 * 1024 * 1024;

type LibraryBackupManifest = {
  readonly format: typeof LIBRARY_BACKUP_FORMAT;
  readonly version: typeof LIBRARY_BACKUP_VERSION;
  readonly schemaVersion: number;
  readonly report: LibraryIntegrityReport;
  readonly artifacts: readonly LibraryBackupArtifact[];
};

type LibraryBackupArtifact = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type LibraryBackupResult =
  | {
      readonly ok: true;
      readonly value: { readonly path: string; readonly report: LibraryIntegrityReport };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "invalid-arguments"
          | "storage-unavailable"
          | "incompatible-schema"
          | "integrity-failed"
          | "destination-exists"
          | "backup-failed";
      };
    };

export type LibraryRestoreResult =
  | {
      readonly ok: true;
      readonly value: { readonly path: string; readonly report: LibraryIntegrityReport };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "invalid-arguments"
          | "invalid-backup"
          | "destination-exists"
          | "restore-failed";
      };
    };

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLibraryIntegrityReport(value: unknown): value is LibraryIntegrityReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LibraryIntegrityReport>;
  const counts = [
    candidate.items?.total,
    candidate.items?.active,
    candidate.items?.trashed,
    candidate.formats?.total,
    candidate.formats?.managed,
    candidate.formats?.referenced,
  ];
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    counts.every((count) => Number.isSafeInteger(count) && (count ?? -1) >= 0) &&
    candidate.items!.active + candidate.items!.trashed === candidate.items!.total &&
    candidate.formats!.managed + candidate.formats!.referenced === candidate.formats!.total
  );
}

function readBackupManifest(backupRoot: string): LibraryBackupManifest | null {
  let descriptor: number | undefined;
  try {
    const path = join(backupRoot, "manifest.json");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_LIBRARY_BACKUP_MANIFEST_BYTES) return null;

    const buffer = Buffer.allocUnsafe(before.size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !after.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      after.ctimeMs !== current.ctimeMs ||
      bytes !== after.size
    ) {
      return null;
    }

    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const manifest = parsed as Partial<LibraryBackupManifest>;
    const artifacts = manifest.artifacts;
    return manifest.format === LIBRARY_BACKUP_FORMAT &&
      manifest.version === LIBRARY_BACKUP_VERSION &&
      manifest.schemaVersion === SCHEMA_VERSION &&
      isLibraryIntegrityReport(manifest.report) &&
      Array.isArray(artifacts) &&
      artifacts.length > 0 &&
      artifacts.every(
        (artifact) =>
          typeof artifact === "object" &&
          artifact !== null &&
          typeof artifact.path === "string" &&
          Number.isSafeInteger(artifact.bytes) &&
          artifact.bytes >= 0 &&
          typeof artifact.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(artifact.sha256),
      ) &&
      new Set(artifacts.map(({ path }) => path)).size === artifacts.length &&
      artifacts.some(({ path }) => path === "library.sqlite")
      ? (manifest as LibraryBackupManifest)
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireRegularDirectory(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("Expected a regular directory");
  }
}

function copyOwnedLibraryArtifacts(
  database: Database,
  sourceRoot: string,
  destinationRoot: string,
): string[] {
  const copiedPaths: string[] = [];
  const sourceItems = join(sourceRoot, "items");
  const destinationItems = join(destinationRoot, "items");
  const managedFormats = database
    .query<{ sourcePath: unknown; format: unknown }, []>(`
      SELECT source_path AS sourcePath, format
      FROM library_item_formats
      WHERE provenance = 'managed'
      ORDER BY library_item_id, position
    `)
    .all();
  for (const row of managedFormats) {
    const parsedFormat = bookFormatSchema.safeParse({
      sourcePath: row.sourcePath,
      format: row.format,
      addedAt: "2000-01-01T00:00:00.000Z",
      provenance: "managed",
    });
    if (!parsedFormat.success) throw new TypeError("Invalid managed format");
    const sourcePath = resolveManagedFormatPath(
      sourceItems,
      row.sourcePath,
      parsedFormat.data.format,
      true,
    );
    mkdirSync(destinationItems, { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, join(destinationItems, basename(sourcePath)));
    copiedPaths.push(`items/${basename(sourcePath)}`);
  }

  const sourceCovers = join(sourceRoot, "covers");
  const destinationCovers = join(destinationRoot, "covers");
  const covers = database
    .query<{ coverPath: unknown }, []>(`
      SELECT DISTINCT cover_path AS coverPath
      FROM library_items
      WHERE cover_path IS NOT NULL
      ORDER BY cover_path
    `)
    .all();
  for (const row of covers) {
    const sourcePath = resolveOwnedCover(sourceCovers, row.coverPath);
    const source = lstatSync(sourcePath);
    if (!source.isFile() || source.isSymbolicLink()) {
      throw new TypeError("Invalid managed cover");
    }
    const relativePath = relative(resolve(sourceCovers), sourcePath);
    const destinationPath = join(destinationCovers, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    copyFileSync(sourcePath, destinationPath);
    copiedPaths.push(`covers/${relativePath.split(sep).join("/")}`);
  }
  return copiedPaths;
}

function resolveBackupArtifact(backupRoot: string, storedPath: string): string {
  const segments = storedPath.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\")) ||
    (storedPath !== "library.sqlite" && segments[0] !== "items" && segments[0] !== "covers")
  ) {
    throw new TypeError("Invalid backup artifact path");
  }
  const root = resolve(backupRoot);
  const path = resolve(root, ...segments);
  if (path !== join(root, "library.sqlite") && !isInside(root, path)) {
    throw new TypeError("Invalid backup artifact path");
  }
  return path;
}

function fingerprintBackupArtifacts(
  backupRoot: string,
  paths: readonly string[],
): LibraryBackupArtifact[] {
  return [...new Set(paths)]
    .sort()
    .map((path) => {
      const fingerprint = fingerprintFile(resolveBackupArtifact(backupRoot, path));
      if (!fingerprint.ok) throw new TypeError("Invalid backup artifact");
      return { path, ...fingerprint.value };
    });
}

function verifyBackupArtifacts(backupRoot: string, artifacts: readonly LibraryBackupArtifact[]): boolean {
  try {
    return artifacts.every((artifact) => {
      const fingerprint = fingerprintFile(resolveBackupArtifact(backupRoot, artifact.path));
      return (
        fingerprint.ok &&
        fingerprint.value.bytes === artifact.bytes &&
        fingerprint.value.sha256 === artifact.sha256
      );
    });
  } catch {
    return false;
  }
}

/** Creates a verified snapshot containing the database and every Takio-owned file. */
export function createLibraryBackup(
  databasePath: string,
  destinationPath: string,
): LibraryBackupResult {
  if (databasePath.length === 0 || destinationPath.length === 0) {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  const resolvedDatabasePath = resolve(databasePath);
  const sourceRoot = dirname(resolvedDatabasePath);
  const destinationRoot = resolve(destinationPath);
  if (destinationRoot === sourceRoot || isInside(sourceRoot, destinationRoot)) {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  if (pathExists(destinationRoot)) {
    return { ok: false, error: { code: "destination-exists" } };
  }

  const sourceIntegrity = verifyLibraryIntegrity(resolvedDatabasePath);
  if (!sourceIntegrity.ok) return sourceIntegrity;

  const destinationParent = dirname(destinationRoot);
  const temporaryRoot = join(
    destinationParent,
    `.${basename(destinationRoot)}.${randomUUID()}.tmp`,
  );
  let database: Database | null = null;
  try {
    mkdirSync(destinationParent, { recursive: true });
    mkdirSync(temporaryRoot, { mode: 0o700 });
    database = new Database(resolvedDatabasePath, { readonly: true, strict: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA foreign_keys = ON");
    database.run("BEGIN");
    verifyV8Database(database, join(sourceRoot, "covers"), join(sourceRoot, "items"));
    const snapshotPath = join(temporaryRoot, "library.sqlite");
    writeFileSync(snapshotPath, database.serialize(), { mode: 0o600 });
    const snapshot = new Database(snapshotPath, { strict: true });
    const hasSourceCleanup = snapshot
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'source_file_cleanup'",
      )
      .get();
    if (hasSourceCleanup) snapshot.run("DELETE FROM source_file_cleanup");
    snapshot.close();
    const ownedPaths = copyOwnedLibraryArtifacts(database, sourceRoot, temporaryRoot);
    database.run("ROLLBACK");
    database.close();
    database = null;

    const backupIntegrity = verifyLibraryIntegrity(join(temporaryRoot, "library.sqlite"));
    if (!backupIntegrity.ok) throw new TypeError("Invalid backup snapshot");
    const manifest: LibraryBackupManifest = {
      format: LIBRARY_BACKUP_FORMAT,
      version: LIBRARY_BACKUP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      report: backupIntegrity.value,
      artifacts: fingerprintBackupArtifacts(temporaryRoot, ["library.sqlite", ...ownedPaths]),
    };
    writeFileSync(join(temporaryRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    if (pathExists(destinationRoot)) {
      return { ok: false, error: { code: "destination-exists" } };
    }
    renameSync(temporaryRoot, destinationRoot);
    return {
      ok: true,
      value: { path: destinationRoot, report: backupIntegrity.value },
    };
  } catch {
    return { ok: false, error: { code: "backup-failed" } };
  } finally {
    try {
      database?.run("ROLLBACK");
    } catch {
      // Best-effort cleanup of the read transaction.
    }
    database?.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Restores a verified snapshot into a new library directory without overwriting data. */
export function restoreLibraryBackup(
  sourcePath: string,
  databasePath: string,
): LibraryRestoreResult {
  if (sourcePath.length === 0 || databasePath.length === 0) {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  const sourceRoot = resolve(sourcePath);
  const resolvedDatabasePath = resolve(databasePath);
  const destinationRoot = dirname(resolvedDatabasePath);
  if (sourceRoot === destinationRoot || isInside(sourceRoot, destinationRoot)) {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  if (pathExists(destinationRoot)) {
    return { ok: false, error: { code: "destination-exists" } };
  }

  try {
    requireRegularDirectory(sourceRoot);
  } catch {
    return { ok: false, error: { code: "invalid-backup" } };
  }
  const manifest = readBackupManifest(sourceRoot);
  const sourceIntegrity = verifyLibraryIntegrity(join(sourceRoot, "library.sqlite"));
  if (
    !manifest ||
    !sourceIntegrity.ok ||
    JSON.stringify(manifest.report) !== JSON.stringify(sourceIntegrity.value) ||
    !verifyBackupArtifacts(sourceRoot, manifest.artifacts)
  ) {
    return { ok: false, error: { code: "invalid-backup" } };
  }

  const destinationParent = dirname(destinationRoot);
  const temporaryRoot = join(
    destinationParent,
    `.${basename(destinationRoot)}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(destinationParent, { recursive: true });
    mkdirSync(temporaryRoot, { mode: 0o700 });
    for (const artifact of manifest.artifacts) {
      const sourceArtifactPath = resolveBackupArtifact(sourceRoot, artifact.path);
      const destinationArtifactPath =
        artifact.path === "library.sqlite"
          ? join(temporaryRoot, basename(resolvedDatabasePath))
          : resolveBackupArtifact(temporaryRoot, artifact.path);
      mkdirSync(dirname(destinationArtifactPath), { recursive: true, mode: 0o700 });
      copyFileSync(sourceArtifactPath, destinationArtifactPath);
      const copied = fingerprintFile(destinationArtifactPath);
      if (
        !copied.ok ||
        copied.value.bytes !== artifact.bytes ||
        copied.value.sha256 !== artifact.sha256
      ) {
        throw new TypeError("Changed restored artifact");
      }
    }

    const restoredIntegrity = verifyLibraryIntegrity(
      join(temporaryRoot, basename(resolvedDatabasePath)),
    );
    if (!restoredIntegrity.ok) throw new TypeError("Invalid restored snapshot");
    if (pathExists(destinationRoot)) {
      return { ok: false, error: { code: "destination-exists" } };
    }
    renameSync(temporaryRoot, destinationRoot);
    return {
      ok: true,
      value: { path: resolvedDatabasePath, report: restoredIntegrity.value },
    };
  } catch {
    return { ok: false, error: { code: "restore-failed" } };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
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

function writeCustomMetadata(
  database: Database,
  itemId: string,
  metadata: NonNullable<LibraryItem["customMetadata"]>,
): void {
  for (const [name, value] of Object.entries(metadata)) {
    database.run(
      `INSERT INTO library_item_custom_metadata
        (library_item_id, name, value) VALUES (?, ?, ?)`,
      [itemId, name, value],
    );
  }
}

function writeRichMetadata(database: Database, item: LibraryItem): void {
  writeAuthors(database, item.id, item.authors ?? []);
  writeLanguages(database, item.id, item.languages ?? []);
  writeIdentifiers(database, item.id, item.identifiers ?? {});
  writeCustomMetadata(database, item.id, item.customMetadata ?? {});
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
      OR EXISTS (
        SELECT 1 FROM library_item_custom_metadata
        WHERE library_item_custom_metadata.library_item_id = library_items.id
          AND (library_item_custom_metadata.name LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR library_item_custom_metadata.value LIKE ? ESCAPE '\\' COLLATE NOCASE)
      )
    )`);
    parameters.push(
      pattern, pattern, pattern, pattern, pattern, pattern,
      pattern, pattern, pattern, pattern, pattern,
    );
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
  queryTestSeam.beforeHydrationQuery?.("customMetadata");
  const customMetadata = database
    .query<StoredItemCustomMetadata, [string]>(`
      SELECT library_item_id AS libraryItemId, name, value
      FROM library_item_custom_metadata
      WHERE library_item_id IN (SELECT value FROM json_each(?))
      ORDER BY library_item_id, name
    `)
    .all(encodedIds);

  const groupedFormats = groupStoredRows(ids, formats);
  const groupedTags = groupStoredRows(ids, tags);
  const groupedAuthors = groupStoredRows(ids, authors);
  const groupedLanguages = groupStoredRows(ids, languages);
  const groupedIdentifiers = groupStoredRows(ids, identifiers);
  const groupedCustomMetadata = groupStoredRows(ids, customMetadata);
  if (
    !groupedFormats ||
    !groupedTags ||
    !groupedAuthors ||
    !groupedLanguages ||
    !groupedIdentifiers ||
    !groupedCustomMetadata
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
    const customMetadataEntries = groupedCustomMetadata
      .get(id)!
      .map(({ name, value }) => [name, value]);

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
        customMetadata:
          customMetadataEntries.length === 0
            ? undefined
            : Object.fromEntries(customMetadataEntries),
      },
    );
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return success(items);
}

type DuplicateFormatRow = StoredItemFormat & StoredFingerprint;
type DuplicateScanResult = {
  candidates: readonly DuplicateCandidate[];
  scan: {
    filesHashed: number;
    fingerprintsReused: number;
    unreadableFormats: number;
  };
};

function normalizeDuplicateText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function compareDuplicateStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicatePairKey(leftId: string, rightId: string): string {
  return JSON.stringify([leftId, rightId]);
}

function addDuplicateSignal(
  signalsByPair: Map<string, Map<string, DuplicateSignal>>,
  leftId: string,
  rightId: string,
  signal: DuplicateSignal,
): void {
  if (leftId === rightId) {
    return;
  }
  const [canonicalLeft, canonicalRight] =
    compareDuplicateStrings(leftId, rightId) < 0 ? [leftId, rightId] : [rightId, leftId];
  const pairKey = duplicatePairKey(canonicalLeft, canonicalRight);
  let signals = signalsByPair.get(pairKey);
  if (!signals) {
    signals = new Map();
    signalsByPair.set(pairKey, signals);
  }
  signals.set(JSON.stringify(signal), signal);
}

function duplicateSignalSortKey(signal: DuplicateSignal): string {
  switch (signal.kind) {
    case "same-content":
      return `0\u0000${signal.leftFormat}\u0000${signal.rightFormat}\u0000${String(signal.bytes).padStart(16, "0")}\u0000${signal.sha256}`;
    case "same-identifier":
      return `1\u0000${normalizeDuplicateText(signal.scheme)}\u0000${signal.value}`;
    case "same-title-author":
      return `2\u0000${normalizeDuplicateText(signal.title)}\u0000${normalizeDuplicateText(signal.author)}`;
  }
}

function duplicateAuthors(item: LibraryItem): readonly string[] {
  const values = item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []);
  return [...new Map(values.map((value) => [normalizeDuplicateText(value), value.trim()])).values()]
    .filter((value) => normalizeDuplicateText(value).length > 0)
    .sort((left, right) =>
      compareDuplicateStrings(normalizeDuplicateText(left), normalizeDuplicateText(right)),
    );
}

function scanDuplicateCandidates(
  database: Database,
  coversDirectory: string,
  itemsDirectory: string,
): LibraryStoreResult<DuplicateScanResult> {
  const rows = database
    .query<StoredLibraryItem, []>(`
      SELECT id, title, added_at AS addedAt,
        author, series, series_index AS seriesIndex, publisher,
        published_date AS publishedDate, rating,
        description, cover_path AS coverPath, updated_at AS updatedAt
      FROM library_items
      WHERE trashed_at IS NULL
      ORDER BY id
    `)
    .all();
  const hydrated = hydrateLibraryPage(database, coversDirectory, itemsDirectory, rows);
  if (!hydrated.ok) {
    return hydrated;
  }

  const itemsById = new Map(hydrated.value.map((item) => [item.id, item]));
  const signalsByPair = new Map<string, Map<string, DuplicateSignal>>();
  const formats = database
    .query<DuplicateFormatRow, []>(`
      SELECT library_item_formats.library_item_id AS libraryItemId,
        library_item_formats.source_path AS sourcePath,
        library_item_formats.format,
        library_item_formats.added_at AS addedAt,
        library_item_formats.provenance,
        library_item_formats.position,
        library_item_formats.content_bytes AS contentBytes,
        library_item_formats.content_sha256 AS contentSha256
      FROM library_item_formats
      JOIN library_items ON library_items.id = library_item_formats.library_item_id
      WHERE library_items.trashed_at IS NULL
      ORDER BY library_item_formats.library_item_id, library_item_formats.position
    `)
    .all();
  const fingerprints = new Map<
    string,
    { itemId: string; format: FormatId; bytes: number; sha256: string }[]
  >();
  let filesHashed = 0;
  let fingerprintsReused = 0;
  let unreadableFormats = 0;

  for (const row of formats) {
    const parsedFormat = bookFormatSchema.safeParse({
      sourcePath: row.sourcePath,
      format: row.format,
      addedAt: row.addedAt,
      provenance: row.provenance,
    });
    if (!parsedFormat.success || !Number.isSafeInteger(row.position) || (row.position as number) < 0) {
      return failure("invalid-stored-data");
    }

    let fingerprint: ExpectedArtifact | null = null;
    if (parsedFormat.data.provenance === "managed") {
      if (!isStoredManagedFingerprint({ bytes: row.contentBytes, sha256: row.contentSha256 })) {
        return failure("invalid-stored-data");
      }
      fingerprint = { bytes: row.contentBytes as number, sha256: row.contentSha256 as string };
      fingerprintsReused += 1;
    } else {
      const current = fingerprintFile(parsedFormat.data.sourcePath);
      if (!current.ok) {
        unreadableFormats += 1;
        continue;
      }
      fingerprint = current.value;
      filesHashed += 1;
    }
    if (fingerprint.bytes === 0) {
      continue;
    }
    const key = `${fingerprint.bytes}\u0000${fingerprint.sha256}`;
    const entries = fingerprints.get(key) ?? [];
    entries.push({
      itemId: row.libraryItemId,
      format: parsedFormat.data.format,
      bytes: fingerprint.bytes,
      sha256: fingerprint.sha256,
    });
    fingerprints.set(key, entries);
  }

  for (const entries of fingerprints.values()) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const leftEntry = entries[leftIndex]!;
        const rightEntry = entries[rightIndex]!;
        const [left, right] =
          compareDuplicateStrings(leftEntry.itemId, rightEntry.itemId) < 0
            ? [leftEntry, rightEntry]
            : [rightEntry, leftEntry];
        addDuplicateSignal(signalsByPair, left.itemId, right.itemId, {
          kind: "same-content",
          leftFormat: left.format,
          rightFormat: right.format,
          bytes: left.bytes,
          sha256: left.sha256,
        });
      }
    }
  }

  const identifiers = new Map<string, { itemId: string; scheme: string; value: string }[]>();
  const titlesAndAuthors = new Map<string, { itemId: string; title: string; author: string }[]>();
  for (const item of hydrated.value) {
    for (const [scheme, value] of Object.entries(item.identifiers ?? {})) {
      const normalizedScheme = normalizeDuplicateText(scheme);
      const canonicalValue = value.trim();
      if (normalizedScheme.length === 0 || canonicalValue.length === 0) {
        continue;
      }
      const key = JSON.stringify([normalizedScheme, canonicalValue]);
      const entries = identifiers.get(key) ?? [];
      entries.push({ itemId: item.id, scheme: scheme.trim(), value: canonicalValue });
      identifiers.set(key, entries);
    }
    const normalizedTitle = normalizeDuplicateText(item.title);
    if (normalizedTitle.length > 0) {
      for (const author of duplicateAuthors(item)) {
        const key = JSON.stringify([normalizedTitle, normalizeDuplicateText(author)]);
        const entries = titlesAndAuthors.get(key) ?? [];
        entries.push({ itemId: item.id, title: item.title.trim(), author: author.trim() });
        titlesAndAuthors.set(key, entries);
      }
    }
  }

  for (const entries of identifiers.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        addDuplicateSignal(signalsByPair, entries[left]!.itemId, entries[right]!.itemId, {
          kind: "same-identifier",
          scheme: entries[left]!.scheme,
          value: entries[left]!.value,
        });
      }
    }
  }
  for (const entries of titlesAndAuthors.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        addDuplicateSignal(signalsByPair, entries[left]!.itemId, entries[right]!.itemId, {
          kind: "same-title-author",
          title: entries[left]!.title,
          author: entries[left]!.author,
        });
      }
    }
  }

  const candidates: DuplicateCandidate[] = [];
  for (const [key, signalMap] of signalsByPair) {
    const pair = JSON.parse(key) as unknown;
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    ) {
      return failure("invalid-stored-data");
    }
    const [leftId, rightId] = pair;
    const left = itemsById.get(leftId);
    const right = itemsById.get(rightId);
    if (!left || !right) {
      return failure("invalid-stored-data");
    }
    const signals = [...signalMap.values()].sort((a, b) =>
      compareDuplicateStrings(duplicateSignalSortKey(a), duplicateSignalSortKey(b)),
    );
    const reviewToken = createHash("sha256")
      .update(JSON.stringify({ version: 1, leftId, rightId, signals }))
      .digest("hex");
    candidates.push({ left, right, signals, reviewToken });
  }
  candidates.sort((left, right) => {
    const bySignals = compareDuplicateStrings(
      duplicateSignalSortKey(left.signals[0]!),
      duplicateSignalSortKey(right.signals[0]!),
    );
    if (bySignals !== 0) return bySignals;
    const byLeftTitle = compareDuplicateStrings(
      normalizeDuplicateText(left.left.title),
      normalizeDuplicateText(right.left.title),
    );
    if (byLeftTitle !== 0) return byLeftTitle;
    const byRightTitle = compareDuplicateStrings(
      normalizeDuplicateText(left.right.title),
      normalizeDuplicateText(right.right.title),
    );
    if (byRightTitle !== 0) return byRightTitle;
    return (
      compareDuplicateStrings(left.left.id, right.left.id) ||
      compareDuplicateStrings(left.right.id, right.right.id)
    );
  });

  return success({
    candidates,
    scan: { filesHashed, fingerprintsReused, unreadableFormats },
  });
}

function applyDuplicateMetadata(
  current: LibraryItem,
  patch: MergeDuplicatePairRequest["metadata"],
  updatedAt: string,
): LibraryStoreResult<LibraryItem> {
  const authors = patch.authors === null ? undefined : (patch.authors ?? current.authors);
  const author =
    patch.authors !== undefined
      ? authors
          ?.map(({ name }) => name.trim())
          .filter((name) => name.length > 0)
          .join(", ")
      : patch.author === null
        ? undefined
        : (patch.author ?? current.author);
  const updated = libraryItemSchema.safeParse({
    ...current,
    title: patch.title ?? current.title,
    author,
    authors,
    series: patch.series === null ? undefined : (patch.series ?? current.series),
    seriesIndex:
      patch.seriesIndex === null ? undefined : (patch.seriesIndex ?? current.seriesIndex),
    publisher: patch.publisher === null ? undefined : (patch.publisher ?? current.publisher),
    languages: patch.languages === null ? undefined : (patch.languages ?? current.languages),
    identifiers:
      patch.identifiers === null ? undefined : (patch.identifiers ?? current.identifiers),
    customMetadata:
      patch.customMetadata === null
        ? undefined
        : (patch.customMetadata ?? current.customMetadata),
    publishedDate:
      patch.publishedDate === null ? undefined : (patch.publishedDate ?? current.publishedDate),
    rating: patch.rating === null ? undefined : (patch.rating ?? current.rating),
    description:
      patch.description === null ? undefined : (patch.description ?? current.description),
    tags: patch.tags ?? current.tags,
    updatedAt,
  });
  return updated.success ? success(updated.data) : failure("invalid-stored-data");
}

function writeDuplicateMetadata(
  database: Database,
  item: LibraryItem,
  patch: MergeDuplicatePairRequest["metadata"],
): void {
  database.run(
    `UPDATE library_items
      SET title = ?, author = ?, series = ?, series_index = ?,
        publisher = ?, published_date = ?, rating = ?,
        description = ?, updated_at = ?
      WHERE id = ?`,
    [
      item.title,
      item.author ?? null,
      item.series ?? null,
      item.seriesIndex ?? null,
      item.publisher ?? null,
      item.publishedDate ?? null,
      item.rating ?? null,
      item.description ?? null,
      item.updatedAt ?? null,
      item.id,
    ],
  );
  if (patch.tags !== undefined) {
    database.run("DELETE FROM library_item_tags WHERE library_item_id = ?", [item.id]);
    writeTags(database, item.id, item.tags);
    database.run(`
      DELETE FROM tags
      WHERE NOT EXISTS (
        SELECT 1 FROM library_item_tags
        WHERE library_item_tags.tag_normalized_name = tags.normalized_name
      )
    `);
  }
  if (patch.authors !== undefined) {
    database.run("DELETE FROM library_item_authors WHERE library_item_id = ?", [item.id]);
    writeAuthors(database, item.id, item.authors ?? []);
  }
  if (patch.languages !== undefined) {
    database.run("DELETE FROM library_item_languages WHERE library_item_id = ?", [item.id]);
    writeLanguages(database, item.id, item.languages ?? []);
  }
  if (patch.identifiers !== undefined) {
    database.run("DELETE FROM library_item_identifiers WHERE library_item_id = ?", [item.id]);
    writeIdentifiers(database, item.id, item.identifiers ?? {});
  }
  if (patch.customMetadata !== undefined) {
    database.run("DELETE FROM library_item_custom_metadata WHERE library_item_id = ?", [item.id]);
    writeCustomMetadata(database, item.id, item.customMetadata ?? {});
  }
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
    LibraryAdoptionStore,
    LibraryBatchImportStore,
    LibraryDuplicateReviewStore,
    LibraryExportStore,
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
      database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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
          createCustomMetadataTable(database!);
          createSavedLibraryViewsTable(database!);
          createLibraryQueryIndexes(database!);
          createLibraryTrashIndex(database!);
          createManagedFingerprintIndex(database!);
          createDuplicatePairReviewsTable(database!);
          createLibraryAdoptionsTable(database!);
          ensureSourceCleanupTable(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
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
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 2) {
          retainVerifiedV2Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV2ToV3(database!);
          migrateV3ToV4(database!);
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 3) {
          retainVerifiedV3Backup(database!, this.#databasePath, this.#coversDirectory);
          migrateV3ToV4(database!);
          migrateV4ToV5(database!);
          migrateV5ToV6(database!);
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
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
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 5) {
          retainVerifiedV5Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV5ToV6(database!);
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 6) {
          retainVerifiedV6Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV6ToV7(database!, this.#itemsDirectory);
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 7) {
          retainVerifiedV7Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV7ToV8(database!);
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 8) {
          retainVerifiedV8Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV8ToV9(database!);
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version === 9) {
          retainVerifiedV9Backup(
            database!,
            this.#databasePath,
            this.#coversDirectory,
            this.#itemsDirectory,
          );
          migrateV9ToV10(database!);
          verifyV10Database(database!, this.#coversDirectory, this.#itemsDirectory);
          database!.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } else if (version !== SCHEMA_VERSION) {
          throw incompatibleSchema;
        }
        ensureManagedCleanupTable(database!);
        ensureSourceCleanupTable(database!);
      }).immediate();

      retryOwnedFileCleanup(database, this.#coversDirectory, this.#itemsDirectory);
      recoverLibraryAdoptions(database, this.#itemsDirectory);
      retrySourceFileCleanup(database);
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

  #importFingerprinted(
    sourcePath: string,
    format: FormatId,
    normalizedTitle: string,
    artifact: ExpectedArtifact,
    sourceCleanupPath?: string,
  ): { result: ImportLibraryItemResult; failureCode?: BatchImportFailure } {
    if (!this.#database) {
      return { result: failure("storage-unavailable"), failureCode: "storage-unavailable" };
    }
    const id = crypto.randomUUID();
    const addedAt = new Date().toISOString();
    let installed: { path: string; storedPath: string };
    try {
      installed = installManagedFile(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        sourcePath,
        format,
      );
    } catch {
      return { result: failure("storage-unavailable"), failureCode: "storage-unavailable" };
    }
    if (!managedFileMatchesArtifact(installed.path, artifact)) {
      attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
        sourcePath: installed.storedPath,
        kind: "format",
      });
      const sourceStillMatches = managedFileMatchesArtifact(sourcePath, artifact);
      return {
        result: failure(sourceStillMatches ? "storage-unavailable" : "invalid-arguments"),
        failureCode: sourceStillMatches ? "storage-unavailable" : "source-changed",
      };
    }

    const item = libraryItemSchema.safeParse({
      id,
      title: normalizedTitle,
      sourcePath: installed.path,
      format,
      addedAt,
      formats: [
        {
          sourcePath: installed.path,
          format,
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
      return { result: failure("invalid-stored-data"), failureCode: "storage-unavailable" };
    }

    try {
      this.#database.transaction(() => {
        this.#database!.run(
          `INSERT INTO library_items
            (id, title, added_at, author, description, cover_path, updated_at)
            VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
          [id, normalizedTitle, addedAt],
        );
        if (sourceCleanupPath) {
          this.#database!.run(
            `INSERT INTO source_file_cleanup (source_path, content_bytes, content_sha256)
              VALUES (?, ?, ?)`,
            [sourceCleanupPath, artifact.bytes, artifact.sha256],
          );
        }
        this.#database!.run(
          `INSERT INTO library_item_formats
            (library_item_id, format, source_path, added_at, provenance, position,
              content_bytes, content_sha256)
            VALUES (?, ?, ?, ?, 'managed', 0, ?, ?)`,
          [id, format, installed.storedPath, addedAt, artifact.bytes, artifact.sha256],
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
      const code = isDuplicateIdError(error) ? "duplicate-id" : "storage-unavailable";
      return { result: failure(code), failureCode: "storage-unavailable" };
    }

    return {
      result: success(item.data),
    };
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
    const artifact = fingerprintFile(source.path);
    if (!artifact.ok) {
      return failure(artifact.code === "source-changed" ? "invalid-arguments" : "storage-unavailable");
    }
    return this.#importFingerprinted(
      source.path,
      source.format,
      normalizedTitle,
      artifact.value,
    ).result;
  }

  async adopt({ sourcePath, title }: AdoptLibraryItemRequest): Promise<AdoptLibraryItemResult> {
    if (!this.#database) return failure("storage-unavailable");
    const source = readSource(sourcePath);
    const normalizedTitle =
      title === undefined && source
        ? basename(source.path, extname(source.path)).trim()
        : typeof title === "string"
          ? title.trim()
          : "";
    if (!source || normalizedTitle.length === 0) return failure("invalid-arguments");
    const managedRelativePath = relative(this.#itemsDirectory, source.path);
    if (
      managedRelativePath === "" ||
      (!managedRelativePath.startsWith(`..${sep}`) &&
        managedRelativePath !== ".." &&
        !isAbsolute(managedRelativePath))
    ) {
      return failure("invalid-arguments");
    }
    const artifact = fingerprintFile(source.path);
    if (!artifact.ok) {
      return failure(artifact.code === "source-changed" ? "invalid-arguments" : "storage-unavailable");
    }
    const duplicate = this.#database
      .query<{ itemId: string }, [number, string]>(`
        SELECT library_item_id AS itemId
        FROM library_item_formats
        WHERE provenance = 'managed' AND content_bytes = ? AND content_sha256 = ?
        ORDER BY library_item_id, position
        LIMIT 1
      `)
      .get(artifact.value.bytes, artifact.value.sha256);
    if (duplicate) {
      const existing = readStoredItem(
        this.#database,
        this.#coversDirectory,
        this.#itemsDirectory,
        duplicate.itemId,
      );
      if (!existing.ok || !existing.value) return failure("invalid-stored-data");
      return success({
        item: existing.value,
        sourceCleanupPending: queueSourceFileCleanup(
          this.#database,
          source.path,
          artifact.value,
        ),
      });
    }
    const id = crypto.randomUUID();
    const adoptionId = crypto.randomUUID();
    const targetStoredPath = `${id}.${source.format}`;
    const targetPath = resolveManagedFormatPath(this.#itemsDirectory, targetStoredPath, source.format, false);
    const now = new Date().toISOString();
    const adoption: StoredAdoption = {
      id: adoptionId,
      libraryItemId: id,
      title: normalizedTitle,
      sourcePath: source.path,
      targetPath,
      format: source.format,
      contentBytes: artifact.value.bytes,
      contentSha256: artifact.value.sha256,
      state: "pending-rename",
    };
    try {
      mkdirSync(this.#itemsDirectory, { recursive: true });
      validateManagedRoot(this.#itemsDirectory);
      if (!sameDeviceAdoptionPreflight(source.path, this.#itemsDirectory)) {
        return failure("cross-device-move");
      }
      this.#database.run(
        `INSERT INTO library_adoptions
          (id, library_item_id, title, source_path, target_path, format,
            content_bytes, content_sha256, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending-rename', ?, ?)`,
        [
          adoption.id,
          adoption.libraryItemId,
          adoption.title,
          adoption.sourcePath,
          adoption.targetPath,
          adoption.format,
          adoption.contentBytes,
          adoption.contentSha256,
          now,
          now,
        ],
      );
      lifecycleTestSeam.afterAdoptionJournalPlanned?.();
      lifecycleTestSeam.beforeAdoptionRename?.(source.path, targetPath);
      renameSync(source.path, targetPath);
      fsyncPath(targetPath);
      fsyncDirectory(this.#itemsDirectory);
      const sourceDirectory = dirname(source.path);
      if (sourceDirectory !== this.#itemsDirectory) fsyncDirectory(sourceDirectory);
      adoption.state = "renamed";
      this.#database.run("UPDATE library_adoptions SET state = 'renamed', updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        adoption.id,
      ]);
      lifecycleTestSeam.afterAdoptionRenamed?.();
      const item = finalizeAdoption(this.#database, this.#itemsDirectory, adoption);
      return success({ item, sourceCleanupPending: false });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV") {
        this.#database.run("DELETE FROM library_adoptions WHERE id = ?", [adoption.id]);
        return failure("cross-device-move");
      }
      return failure(error === installedArtifactMismatch ? "invalid-arguments" : "storage-unavailable");
    }
  }

  async importMany(request: ImportLibraryItemsRequest): Promise<ImportLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = importLibraryItemsRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    const outcomes: LibraryImportEntryOutcome[] = [];
    const encountered = new Map<string, { itemId: string; format: FormatId }>();
    const fail = (sourcePath: string, code: BatchImportFailure) => {
      outcomes.push({ status: "failed", sourcePath, code });
    };
    const visit = async (sourcePath: string): Promise<void> => {
      let entry: ReturnType<typeof lstatSync>;
      try {
        entry = lstatSync(sourcePath);
      } catch (error) {
        fail(
          sourcePath,
          typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
            ? "not-found"
            : "unreadable",
        );
        return;
      }

      if (entry.isSymbolicLink()) {
        outcomes.push({ status: "skipped", sourcePath, reason: "symbolic-link" });
        return;
      }
      if (entry.isDirectory()) {
        let names: string[];
        try {
          names = readdirSync(sourcePath).sort();
        } catch {
          fail(sourcePath, "unreadable");
          return;
        }
        for (const name of names) {
          await visit(join(sourcePath, name));
        }
        return;
      }
      if (!entry.isFile()) {
        outcomes.push({ status: "skipped", sourcePath, reason: "unsupported-file-type" });
        return;
      }

      if (basename(sourcePath).startsWith("._")) {
        outcomes.push({ status: "skipped", sourcePath, reason: "unsupported-format" });
        return;
      }
      const format = detectFormat(sourcePath);
      if (!format) {
        outcomes.push({ status: "skipped", sourcePath, reason: "unsupported-format" });
        return;
      }
      const normalizedTitle = basename(sourcePath, extname(sourcePath)).trim();
      if (normalizedTitle.length === 0) {
        fail(sourcePath, "invalid-title");
        return;
      }
      const fingerprint = fingerprintFile(sourcePath, entry);
      if (!fingerprint.ok) {
        fail(sourcePath, fingerprint.code);
        return;
      }
      const key = `${fingerprint.value.bytes}:${fingerprint.value.sha256}`;
      const moveSource = parsedRequest.data.mode === "move" ? realpathSync(sourcePath) : undefined;
      const earlier = encountered.get(key);
      if (earlier) {
        outcomes.push({
          status: "duplicate",
          sourcePath,
          existing: earlier,
          reason: "earlier-in-request",
          ...(moveSource
            ? {
                sourceCleanupPending: queueSourceFileCleanup(
                  this.#database!,
                  moveSource,
                  fingerprint.value,
                ),
              }
            : {}),
        });
        return;
      }

      let existing: { itemId: string; format: FormatId } | null = null;
      try {
        const row = this.#database!
          .query<{ itemId: string; format: unknown }, [number, string]>(`
            SELECT library_item_id AS itemId, format
            FROM library_item_formats
            WHERE provenance = 'managed'
              AND content_bytes = ? AND content_sha256 = ?
            ORDER BY library_item_id, position
            LIMIT 1
          `)
          .get(fingerprint.value.bytes, fingerprint.value.sha256);
        if (row) {
          if (!FORMAT_IDS.includes(row.format as FormatId)) {
            fail(sourcePath, "storage-unavailable");
            return;
          }
          existing = { itemId: row.itemId, format: row.format as FormatId };
        }
      } catch {
        fail(sourcePath, "storage-unavailable");
        return;
      }
      if (existing) {
        encountered.set(key, existing);
        outcomes.push({
          status: "duplicate",
          sourcePath,
          existing,
          reason: "existing-library",
          ...(moveSource
            ? {
                sourceCleanupPending: queueSourceFileCleanup(
                  this.#database!,
                  moveSource,
                  fingerprint.value,
                ),
              }
            : {}),
        });
        return;
      }

      if (moveSource) {
        const adopted = await this.adopt({ sourcePath: moveSource, title: normalizedTitle });
        if (!adopted.ok) {
          fail(sourcePath, adopted.error.code === "cross-device-move" ? "cross-device-move" : "storage-unavailable");
          return;
        }
        const importedReference = { itemId: adopted.value.item.id, format };
        encountered.set(key, importedReference);
        outcomes.push({
          status: "imported",
          sourcePath,
          item: adopted.value.item,
          sourceCleanupPending: adopted.value.sourceCleanupPending,
        });
        return;
      }

      const imported = this.#importFingerprinted(
        sourcePath,
        format,
        normalizedTitle,
        fingerprint.value,
      );
      if (!imported.result.ok) {
        fail(sourcePath, imported.failureCode ?? "storage-unavailable");
        return;
      }
      const importedReference = { itemId: imported.result.value.id, format };
      encountered.set(key, importedReference);
      outcomes.push({
        status: "imported",
        sourcePath,
        item: imported.result.value,
      });
    };

    for (const root of parsedRequest.data.roots) {
      await visit(root);
    }
    return success({
      outcomes,
      counts: {
        total: outcomes.length,
        imported: outcomes.filter(({ status }) => status === "imported").length,
        skipped: outcomes.filter(({ status }) => status === "skipped").length,
        duplicates: outcomes.filter(({ status }) => status === "duplicate").length,
        failed: outcomes.filter(({ status }) => status === "failed").length,
      },
    });
  }

  async exportMany(request: ExportLibraryItemsRequest): Promise<ExportLibraryItemsResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = exportLibraryItemsRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    let destinationDirectory: string;
    try {
      destinationDirectory = realpathSync(parsedRequest.data.destinationPath);
      if (!lstatSync(destinationDirectory).isDirectory()) {
        return failure("invalid-arguments");
      }
    } catch {
      return failure("invalid-arguments");
    }

    type PreparedFormat = {
      format: FormatId;
      provenance: BookFormatProvenance;
      sourcePath: string | null;
    };
    type PreparedItem =
      | { itemId: string; missing: true }
      | {
          itemId: string;
          missing: false;
          title: string;
          author: string | null;
          series: string | null;
          formats: PreparedFormat[];
        };
    let items: PreparedItem[];
    try {
      items = this.#database.transaction(() =>
        parsedRequest.data.ids.map((itemId): PreparedItem => {
          const item = this.#database!
            .query<{ title: unknown; author: unknown; series: unknown }, [string]>(`
              SELECT library_items.title,
                COALESCE(
                  (SELECT name
                    FROM library_item_authors
                    WHERE library_item_id = library_items.id
                    ORDER BY position
                    LIMIT 1),
                  library_items.author
                ) AS author,
                library_items.series
              FROM library_items
              WHERE library_items.id = ? AND library_items.trashed_at IS NULL
            `)
            .get(itemId);
          if (!item) {
            return { itemId, missing: true };
          }
          if (typeof item.title !== "string" || item.title.length === 0) {
            throw invalidStoredExport;
          }
          if (
            parsedRequest.data.fileNameTemplate === "author-title" &&
            item.author !== null &&
            (typeof item.author !== "string" || item.author.length === 0)
          ) {
            throw invalidStoredExport;
          }
          if (item.series !== null && (typeof item.series !== "string" || item.series.length === 0)) {
            throw invalidStoredExport;
          }

          const rows = this.#database!
            .query<StoredPositionedBookFormat, [string]>(`
              SELECT source_path AS sourcePath, format, added_at AS addedAt,
                provenance, position
              FROM library_item_formats
              WHERE library_item_id = ?
              ORDER BY position
            `)
            .all(itemId);
          if (rows.length === 0) {
            throw invalidStoredExport;
          }
          const formats = rows.map((row, position): PreparedFormat => {
            if (
              row.position !== position ||
              !FORMAT_IDS.includes(row.format as FormatId) ||
              (row.provenance !== "managed" && row.provenance !== "referenced")
            ) {
              throw invalidStoredExport;
            }
            const format = row.format as FormatId;
            const provenance = row.provenance as BookFormatProvenance;
            let sourcePath: string | null = null;
            if (typeof row.sourcePath === "string" && row.sourcePath.length > 0) {
              try {
                sourcePath =
                  provenance === "managed"
                    ? resolveManagedFormatPath(
                        this.#itemsDirectory,
                        row.sourcePath,
                        format,
                        false,
                      )
                    : row.sourcePath;
              } catch {
                sourcePath = null;
              }
            }
            return { format, provenance, sourcePath };
          });
          return {
            itemId,
            missing: false,
            title: item.title,
            author: typeof item.author === "string" ? item.author : null,
            series: typeof item.series === "string" ? item.series : null,
            formats,
          };
        }),
      )();
    } catch (error) {
      return failure(error === invalidStoredExport ? "invalid-stored-data" : "storage-unavailable");
    }

    const outcomes: LibraryExportEntryOutcome[] = [];
    for (const item of items) {
      if (item.missing) {
        outcomes.push({ status: "failed", itemId: item.itemId, code: "item-not-found" });
        continue;
      }
      const requestedDirectory = requestedExportDirectory(
        destinationDirectory,
        parsedRequest.data.directoryTemplate,
        item.author,
        item.series,
      );
      const exportDirectory = prepareExportDirectory(destinationDirectory, requestedDirectory);
      for (const format of item.formats) {
        const destinationPath = join(
          exportDirectory ?? requestedDirectory,
          exportFileName(
            item.title,
            item.author,
            parsedRequest.data.fileNameTemplate,
            item.itemId,
            format.format,
          ),
        );
        const target = {
          itemId: item.itemId,
          format: format.format,
          provenance: format.provenance,
          destinationPath,
        } as const;
        if (exportDirectory === null) {
          outcomes.push({ status: "failed", ...target, code: "destination-unavailable" });
          continue;
        }
        if (format.sourcePath === null) {
          outcomes.push({
            status: "failed",
            ...target,
            code: "source-unavailable",
          });
          continue;
        }
        const copied = copyExportFile(format.sourcePath, destinationPath);
        if (copied.status === "exported") {
          outcomes.push({
            status: "exported",
            ...target,
            bytes: copied.bytes,
            sha256: copied.sha256,
          });
        } else if (copied.status === "skipped") {
          outcomes.push({ status: "skipped", ...target, reason: "destination-exists" });
        } else {
          outcomes.push({ status: "failed", ...target, code: copied.code });
        }
      }
    }

    return success({
      outcomes,
      counts: {
        total: outcomes.length,
        exported: outcomes.filter(({ status }) => status === "exported").length,
        skipped: outcomes.filter(({ status }) => status === "skipped").length,
        failed: outcomes.filter(({ status }) => status === "failed").length,
      },
    });
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
    let installedFingerprint: ExpectedArtifact | undefined;
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
        const fingerprint = fingerprintFile(installed.path);
        if (!fingerprint.ok) {
          throw new TypeError("Installed format could not be fingerprinted");
        }
        installedFingerprint = fingerprint.value;
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
            (library_item_id, format, source_path, added_at, provenance, position,
              content_bytes, content_sha256)
            VALUES (?, ?, ?, ?, ?,
              (SELECT COALESCE(MAX(position), -1) + 1
                FROM library_item_formats WHERE library_item_id = ?), ?, ?)`,
          [
            id,
            inspected.format,
            storedSourcePath,
            addedAt,
            installed ? "managed" : "referenced",
            id,
            installedFingerprint?.bytes ?? null,
            installedFingerprint?.sha256 ?? null,
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
    let installedFingerprint: ExpectedArtifact | undefined;
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
        const fingerprint = fingerprintFile(installed.path);
        if (!fingerprint.ok) {
          throw new TypeError("Installed format could not be fingerprinted");
        }
        installedFingerprint = fingerprint.value;
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
            SET source_path = ?, added_at = ?, provenance = ?,
              content_bytes = ?, content_sha256 = ?
            WHERE library_item_id = ? AND format = ?`,
          [
            storedSourcePath,
            addedAt,
            installed ? "managed" : "referenced",
            installedFingerprint?.bytes ?? null,
            installedFingerprint?.sha256 ?? null,
            id,
            format,
          ],
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
        const requestedCustomMetadata =
          parsedPatch.data.customMetadata === null
            ? {}
            : (parsedPatch.data.customMetadata ?? current.value.customMetadata ?? {});
        const audit = current.value.customMetadata?.[METADATA_CANDIDATE_AUDIT_KEY];
        const customMetadata =
          audit === undefined
            ? requestedCustomMetadata
            : { ...requestedCustomMetadata, [METADATA_CANDIDATE_AUDIT_KEY]: audit };
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
          customMetadata: Object.keys(customMetadata).length === 0 ? undefined : customMetadata,
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
          tags: parsedPatch.data.tags ?? current.value.tags,
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
        if (parsedPatch.data.tags !== undefined) {
          this.#database!.run("DELETE FROM library_item_tags WHERE library_item_id = ?", [id]);
          writeTags(this.#database!, id, updated.data.tags);
          this.#database!.run(`
            DELETE FROM tags
            WHERE NOT EXISTS (
              SELECT 1 FROM library_item_tags
              WHERE library_item_tags.tag_normalized_name = tags.normalized_name
            )
          `);
        }
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
        if (parsedPatch.data.customMetadata !== undefined) {
          this.#database!.run(
            "DELETE FROM library_item_custom_metadata WHERE library_item_id = ?",
            [id],
          );
          writeCustomMetadata(this.#database!, id, updated.data.customMetadata ?? {});
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
        .query<StoredLibraryItem, [string, string, string, string, string, string]>(`
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
              OR EXISTS (
                SELECT 1
                FROM library_item_custom_metadata
                WHERE library_item_custom_metadata.library_item_id = library_items.id
                  AND (library_item_custom_metadata.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR library_item_custom_metadata.value LIKE ? ESCAPE '\\' COLLATE NOCASE)
              )
            )
          ORDER BY title COLLATE NOCASE, id
        `)
        .all(pattern, pattern, pattern, pattern, pattern, pattern);
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

  async listDuplicateCandidates(
    request: ListDuplicateCandidatesRequest,
  ): Promise<ListDuplicateCandidatesResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = listDuplicateCandidatesRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    try {
      return this.#database.transaction((): ListDuplicateCandidatesResult => {
        const scanned = scanDuplicateCandidates(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
        );
        if (!scanned.ok) {
          return scanned;
        }
        const reviews = this.#database!
          .query<
            { leftId: unknown; rightId: unknown; reviewToken: unknown; reviewedAt: unknown },
            []
          >(`
            SELECT left_id AS leftId, right_id AS rightId,
              review_token AS reviewToken, reviewed_at AS reviewedAt
            FROM duplicate_pair_reviews
          `)
          .all();
        const reviewedTokens = new Map<string, string>();
        for (const row of reviews) {
          if (
            typeof row.leftId !== "string" ||
            typeof row.rightId !== "string" ||
            row.leftId >= row.rightId ||
            typeof row.reviewToken !== "string" ||
            !/^[0-9a-f]{64}$/.test(row.reviewToken) ||
            !isStoredTrashTimestamp(row.reviewedAt)
          ) {
            return failure("invalid-stored-data");
          }
          reviewedTokens.set(duplicatePairKey(row.leftId, row.rightId), row.reviewToken);
        }
        const matching = scanned.value.candidates.filter((candidate) => {
          const reviewed =
            reviewedTokens.get(duplicatePairKey(candidate.left.id, candidate.right.id)) ===
            candidate.reviewToken;
          return parsedRequest.data.disposition === "kept-both" ? reviewed : !reviewed;
        });
        const page = duplicateCandidatePageSchema.safeParse({
          candidates: matching.slice(
            parsedRequest.data.page.offset,
            parsedRequest.data.page.offset + parsedRequest.data.page.limit,
          ),
          total: matching.length,
          page: parsedRequest.data.page,
          scan: scanned.value.scan,
        });
        return page.success ? success(page.data) : failure("invalid-stored-data");
      })();
    } catch {
      return failure("storage-unavailable");
    }
  }

  #setDuplicateDisposition(
    request: KeepDuplicatePairRequest | ReopenDuplicatePairRequest,
    keep: boolean,
  ): KeepDuplicatePairResult | ReopenDuplicatePairResult {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    try {
      return this.#database.transaction((): KeepDuplicatePairResult => {
        const scanned = scanDuplicateCandidates(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
        );
        if (!scanned.ok) {
          return scanned;
        }
        const candidate = scanned.value.candidates.find(
          ({ left, right }) => left.id === request.leftId && right.id === request.rightId,
        );
        if (!candidate || candidate.reviewToken !== request.reviewToken) {
          return failure("stale-review");
        }
        if (keep) {
          this.#database!.run(
            `INSERT INTO duplicate_pair_reviews (left_id, right_id, review_token, reviewed_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(left_id, right_id) DO UPDATE SET
                review_token = excluded.review_token,
                reviewed_at = excluded.reviewed_at`,
            [request.leftId, request.rightId, request.reviewToken, new Date().toISOString()],
          );
        } else {
          const reviewed = this.#database!
            .query<{ reviewToken: unknown }, [string, string]>(
              `SELECT review_token AS reviewToken
                FROM duplicate_pair_reviews
                WHERE left_id = ? AND right_id = ?`,
            )
            .get(request.leftId, request.rightId);
          if (!reviewed || reviewed.reviewToken !== request.reviewToken) {
            return failure("stale-review");
          }
          this.#database!.run(
            "DELETE FROM duplicate_pair_reviews WHERE left_id = ? AND right_id = ?",
            [request.leftId, request.rightId],
          );
        }
        return success(null);
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  async keepDuplicatePair(request: KeepDuplicatePairRequest): Promise<KeepDuplicatePairResult> {
    const parsedRequest = keepDuplicatePairRequestSchema.safeParse(request);
    return parsedRequest.success
      ? this.#setDuplicateDisposition(parsedRequest.data, true)
      : failure("invalid-arguments");
  }

  async reopenDuplicatePair(
    request: ReopenDuplicatePairRequest,
  ): Promise<ReopenDuplicatePairResult> {
    const parsedRequest = reopenDuplicatePairRequestSchema.safeParse(request);
    return parsedRequest.success
      ? this.#setDuplicateDisposition(parsedRequest.data, false)
      : failure("invalid-arguments");
  }

  async mergeDuplicatePair(request: MergeDuplicatePairRequest): Promise<MergeDuplicatePairResult> {
    if (!this.#database) {
      return failure("storage-unavailable");
    }
    const parsedRequest = mergeDuplicatePairRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return failure("invalid-arguments");
    }

    type MergeOutcome =
      | { kind: "failure"; code: LibraryStoreErrorCode }
      | {
          kind: "merged";
          target: LibraryItem;
          source: LibraryItem;
          cleanupPath?: string;
        };
    let outcome: MergeOutcome;
    let rollbackCode: LibraryStoreErrorCode = "storage-unavailable";
    try {
      outcome = this.#database.transaction((): MergeOutcome => {
        const scanned = scanDuplicateCandidates(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
        );
        if (!scanned.ok) {
          return { kind: "failure", code: scanned.error.code };
        }
        const leftId =
          parsedRequest.data.targetId < parsedRequest.data.sourceId
            ? parsedRequest.data.targetId
            : parsedRequest.data.sourceId;
        const rightId =
          parsedRequest.data.targetId < parsedRequest.data.sourceId
            ? parsedRequest.data.sourceId
            : parsedRequest.data.targetId;
        const candidate = scanned.value.candidates.find(
          ({ left, right }) => left.id === leftId && right.id === rightId,
        );
        if (!candidate || candidate.reviewToken !== parsedRequest.data.reviewToken) {
          return { kind: "failure", code: "stale-review" };
        }
        const currentTarget =
          candidate.left.id === parsedRequest.data.targetId ? candidate.left : candidate.right;
        const updatedAt = new Date().toISOString();
        const updatedTarget = applyDuplicateMetadata(
          currentTarget,
          parsedRequest.data.metadata,
          updatedAt,
        );
        if (!updatedTarget.ok) {
          return { kind: "failure", code: updatedTarget.error.code };
        }

        const targetFormats = new Set(currentTarget.formats.map(({ format }) => format));
        const sourceRows = this.#database!
          .query<DuplicateFormatRow, [string]>(`
            SELECT library_item_id AS libraryItemId, source_path AS sourcePath,
              format, added_at AS addedAt, provenance, position,
              content_bytes AS contentBytes, content_sha256 AS contentSha256
            FROM library_item_formats
            WHERE library_item_id = ?
            ORDER BY position
          `)
          .all(parsedRequest.data.sourceId);
        const sourceFormats = new Map<
          FormatId,
          {
            format: FormatId;
            sourcePath: string;
            addedAt: string;
            provenance: "managed" | "referenced";
            contentBytes: number | null;
            contentSha256: string | null;
          }
        >();
        for (const row of sourceRows) {
          const format = bookFormatSchema.safeParse({
            sourcePath: row.sourcePath,
            format: row.format,
            addedAt: row.addedAt,
            provenance: row.provenance,
          });
          if (
            !format.success ||
            !Number.isSafeInteger(row.position) ||
            (row.position as number) < 0 ||
            (format.data.provenance === "managed" &&
              !isStoredManagedFingerprint({ bytes: row.contentBytes, sha256: row.contentSha256 })) ||
            (format.data.provenance === "referenced" &&
              (row.contentBytes !== null || row.contentSha256 !== null))
          ) {
            return { kind: "failure", code: "invalid-stored-data" };
          }
          sourceFormats.set(format.data.format, {
            ...format.data,
            contentBytes: format.data.provenance === "managed" ? (row.contentBytes as number) : null,
            contentSha256:
              format.data.provenance === "managed" ? (row.contentSha256 as string) : null,
          });
        }
        for (const format of parsedRequest.data.addSourceFormats) {
          if (targetFormats.has(format) || !sourceFormats.has(format)) {
            return { kind: "failure", code: "invalid-arguments" };
          }
        }

        const storedCovers = this.#database!
          .query<{ id: unknown; coverPath: unknown }, [string, string]>(`
            SELECT id, cover_path AS coverPath
            FROM library_items
            WHERE id IN (?, ?)
            ORDER BY id
          `)
          .all(parsedRequest.data.targetId, parsedRequest.data.sourceId);
        if (storedCovers.length !== 2) {
          return { kind: "failure", code: "stale-review" };
        }
        const targetCover = storedCovers.find(({ id }) => id === parsedRequest.data.targetId)?.coverPath;
        const sourceCover = storedCovers.find(({ id }) => id === parsedRequest.data.sourceId)?.coverPath;
        if (
          (targetCover !== null && typeof targetCover !== "string") ||
          (sourceCover !== null && typeof sourceCover !== "string")
        ) {
          return { kind: "failure", code: "invalid-stored-data" };
        }
        const selectedCover =
          parsedRequest.data.cover === "target"
            ? targetCover
            : parsedRequest.data.cover === "source"
              ? sourceCover
              : null;
        if (parsedRequest.data.cover === "source" && sourceCover === null) {
          return { kind: "failure", code: "invalid-arguments" };
        }
        if (selectedCover !== null) {
          resolveCoverCleanupPath(this.#coversDirectory, selectedCover);
        }

        writeDuplicateMetadata(this.#database!, updatedTarget.value, parsedRequest.data.metadata);
        const nextPosition = currentTarget.formats.length;
        parsedRequest.data.addSourceFormats.forEach((format, index) => {
          const row = sourceFormats.get(format)!;
          this.#database!.run(
            `INSERT INTO library_item_formats
              (library_item_id, format, source_path, added_at, provenance, position,
                content_bytes, content_sha256)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              parsedRequest.data.targetId,
              row.format,
              row.sourcePath,
              row.addedAt,
              row.provenance,
              nextPosition + index,
              row.contentBytes,
              row.contentSha256,
            ],
          );
        });
        this.#database!.run("UPDATE library_items SET cover_path = ? WHERE id = ?", [
          selectedCover,
          parsedRequest.data.targetId,
        ]);
        const trashed = this.#database!.run(
          "UPDATE library_items SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL",
          [updatedAt, updatedAt, parsedRequest.data.sourceId],
        );
        if (trashed.changes !== 1) {
          rollbackCode = "stale-review";
          throw duplicateMergeRollback;
        }
        this.#database!.run(
          "DELETE FROM duplicate_pair_reviews WHERE left_id = ? AND right_id = ?",
          [leftId, rightId],
        );

        let cleanupPath: string | undefined;
        if (typeof targetCover === "string" && targetCover !== selectedCover) {
          resolveCoverCleanupPath(this.#coversDirectory, targetCover);
          this.#database!.run(
            "INSERT OR IGNORE INTO managed_file_cleanup (source_path, kind) VALUES (?, 'cover')",
            [targetCover],
          );
          cleanupPath = targetCover;
        }
        const storedTarget = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          parsedRequest.data.targetId,
        );
        const storedSource = readStoredItem(
          this.#database!,
          this.#coversDirectory,
          this.#itemsDirectory,
          parsedRequest.data.sourceId,
        );
        if (!storedTarget.ok || !storedSource.ok || !storedTarget.value || !storedSource.value) {
          rollbackCode =
            !storedTarget.ok
              ? storedTarget.error.code
              : !storedSource.ok
                ? storedSource.error.code
                : "invalid-stored-data";
          throw duplicateMergeRollback;
        }
        return {
          kind: "merged",
          target: storedTarget.value,
          source: storedSource.value,
          cleanupPath,
        };
      }).immediate();
    } catch (error) {
      return failure(error === duplicateMergeRollback ? rollbackCode : "storage-unavailable");
    }

    if (outcome.kind === "failure") {
      return failure(outcome.code);
    }
    const cleanupPending =
      outcome.cleanupPath === undefined
        ? false
        : !attemptOwnedFileCleanup(this.#database, this.#coversDirectory, this.#itemsDirectory, {
            sourcePath: outcome.cleanupPath,
            kind: "cover",
          });
    return success({
      target: outcome.target,
      trashedSource: outcome.source,
      cleanupPending,
    });
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
