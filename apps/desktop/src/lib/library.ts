import { invoke } from "@tauri-apps/api/core";
import { FORMAT_IDS, libraryItemSchema, normalizeTags } from "@takio/core";
import type { FormatId, LibraryItem } from "@takio/core";
import {
  duplicateCandidatePageSchema,
  exportLibraryItemsRequestSchema,
  keepDuplicatePairRequestSchema,
  libraryExportReportSchema,
  libraryImportReportSchema,
  libraryQueryPageSchema,
  libraryTrashPageSchema,
  listLibraryTrashRequestSchema,
  listDuplicateCandidatesRequestSchema,
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
  ExportLibraryItemsRequest,
  KeepDuplicatePairRequest,
  LibraryBatchImportWireResult,
  LibraryCoverWireResult,
  LibraryDuplicateCandidatesWireResult,
  LibraryDuplicateDispositionWireResult,
  LibraryDuplicateMergeWireResult,
  LibraryExportWireResult,
  LibraryImportWireResult,
  LibraryListWireResult,
  LibraryMetadataPatch,
  LibraryQueryWireResult,
  LibraryPurgeWireResult,
  LibraryReplaceFormatWireResult,
  LibraryRemoveWireResult,
  LibraryRestoreWireResult,
  LibrarySavedViewWireResult,
  LibrarySavedViewsWireResult,
  LibrarySearchWireResult,
  LibraryStoreResult,
  LibraryTrashListWireResult,
  LibraryTrashWireResult,
  LibraryUpdateWireResult,
  ListDuplicateCandidatesRequest,
  ListLibraryTrashRequest,
  MergeDuplicatePairRequest,
  PurgeLibraryItemRequest,
  QueryLibraryItemsRequest,
  ReplaceLibraryFormatRequest,
  RemoveSavedLibraryViewRequest,
  ReopenDuplicatePairRequest,
  RestoreLibraryItemRequest,
  SaveSavedLibraryViewRequest,
  TrashLibraryItemRequest,
} from "@takio/library-contract";

export type LibraryBridgeErrorCode =
  | "invalid-arguments"
  | "engine-unavailable"
  | "protocol-error";

type LibraryBridgeFailure = {
  readonly ok: false;
  readonly error: { readonly code: LibraryBridgeErrorCode };
};

export type DesktopLibraryListResult = LibraryListWireResult | LibraryBridgeFailure;
export type DesktopLibraryGetResult =
  | LibraryStoreResult<{ readonly item: LibraryItem | null }>
  | LibraryBridgeFailure;
export type DesktopLibraryImportResult = LibraryImportWireResult | LibraryBridgeFailure;
export type DesktopLibraryBatchImportResult =
  | LibraryBatchImportWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryExportResult =
  | LibraryExportWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryAttachFormatResult =
  | LibraryStoreResult<{ readonly item: LibraryItem | null }>
  | LibraryBridgeFailure;
export type DesktopLibraryRemoveFormatResult = LibraryRemoveWireResult | LibraryBridgeFailure;
export type DesktopLibraryReplaceFormatResult =
  | LibraryReplaceFormatWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryRemoveResult = LibraryRemoveWireResult | LibraryBridgeFailure;
export type DesktopLibraryUpdateResult = LibraryUpdateWireResult | LibraryBridgeFailure;
export type DesktopLibraryCoverResult = LibraryCoverWireResult | LibraryBridgeFailure;
export type DesktopLibrarySearchResult = LibrarySearchWireResult | LibraryBridgeFailure;
export type DesktopLibraryQueryResult = LibraryQueryWireResult | LibraryBridgeFailure;
export type DesktopLibraryDuplicateCandidatesResult =
  | LibraryDuplicateCandidatesWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryDuplicateDispositionResult =
  | LibraryDuplicateDispositionWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryDuplicateMergeResult =
  | LibraryDuplicateMergeWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryTrashListResult =
  LibraryTrashListWireResult | LibraryBridgeFailure;
export type DesktopLibraryTrashResult =
  LibraryTrashWireResult | LibraryBridgeFailure;
export type DesktopLibraryRestoreResult =
  LibraryRestoreWireResult | LibraryBridgeFailure;
export type DesktopLibraryPurgeResult =
  LibraryPurgeWireResult | LibraryBridgeFailure;
export type DesktopLibrarySavedViewsResult =
  | LibrarySavedViewsWireResult
  | LibraryBridgeFailure;
export type DesktopLibrarySavedViewResult =
  | LibrarySavedViewWireResult
  | LibraryBridgeFailure;
export type DesktopLibraryOpenResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly id: string;
        readonly format: FormatId;
        readonly path: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string };
    };

export type LibraryInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
export type LibraryFormatAttachMode = "copy" | "reference";

const invokeTauri: LibraryInvoker = (command, args) => invoke(command, args);

function protocolError(): LibraryBridgeFailure {
  return { ok: false, error: { code: "protocol-error" } };
}

function invalidArguments(): LibraryBridgeFailure {
  return { ok: false, error: { code: "invalid-arguments" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFormatId(value: unknown): value is FormatId {
  return typeof value === "string" && FORMAT_IDS.some((format) => format === value);
}

function isLibraryItem(value: unknown): value is LibraryItem {
  return (
    isRecord(value) &&
    Array.isArray(value.tags) &&
    Array.isArray(value.formats) &&
    value.formats.length > 0 &&
    libraryItemSchema.safeParse(value).success
  );
}

function isItemValue(value: unknown, nullable: boolean): boolean {
  return (
    isRecord(value) &&
    "item" in value &&
    (isLibraryItem(value.item) || (nullable && value.item === null))
  );
}

function isItemsValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isLibraryItem)
  );
}

function isRemoveValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    isItemValue(value, true) &&
    typeof value.cleanupPending === "boolean"
  );
}

function hasOnlyKey(value: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

function isStrictItemValue(value: unknown): boolean {
  return (
    isRecord(value) && hasOnlyKey(value, "item") && isItemValue(value, true)
  );
}

function isStrictCleanupValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "item") &&
    Object.hasOwn(value, "cleanupPending") &&
    isRemoveValue(value)
  );
}

function isSavedViewsValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKey(value, "views") &&
    Array.isArray(value.views) &&
    value.views.every((view) => savedLibraryViewSchema.safeParse(view).success)
  );
}

function isSavedViewValue(value: unknown, nullable: boolean): boolean {
  return (
    isRecord(value) &&
    hasOnlyKey(value, "view") &&
    (savedLibraryViewSchema.safeParse(value.view).success ||
      (nullable && value.view === null))
  );
}

function isDuplicateMergeValue(
  value: unknown,
  targetId: string,
  sourceId: string,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, "target") &&
    Object.hasOwn(value, "trashedSource") &&
    Object.hasOwn(value, "cleanupPending") &&
    isLibraryItem(value.target) &&
    value.target.id === targetId &&
    isLibraryItem(value.trashedSource) &&
    value.trashedSource.id === sourceId &&
    typeof value.cleanupPending === "boolean"
  );
}

function decodeLibraryResult<T>(
  result: unknown,
  isValue: (value: unknown) => boolean,
): T | LibraryBridgeFailure {
  if (!isRecord(result)) {
    return protocolError();
  }

  if (
    result.ok === false &&
    isRecord(result.error) &&
    typeof result.error.code === "string" &&
    result.error.code.length > 0
  ) {
    return result as T;
  }

  if (result.ok === true && "value" in result && isValue(result.value)) {
    return result as T;
  }

  return protocolError();
}

export async function listLibraryItems(
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryListResult> {
  const result = await invokeCommand<unknown>("library_list");
  return decodeLibraryResult<LibraryListWireResult>(result, isItemsValue);
}

export async function getLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryGetResult> {
  if (id.trim() === "") {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_get", { id });
  return decodeLibraryResult<DesktopLibraryGetResult>(result, isStrictItemValue);
}

export async function importLibraryItem(
  sourcePath: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryImportResult> {
  const result = await invokeCommand<unknown>("library_import", { sourcePath });
  return decodeLibraryResult<LibraryImportWireResult>(result, (value) =>
    isItemValue(value, false),
  );
}

export async function importLibraryItems(
  sourcePaths: readonly string[],
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryBatchImportResult> {
  const result = await invokeCommand<unknown>("library_import_many", {
    sourcePaths: [...sourcePaths],
  });
  return decodeLibraryResult<LibraryBatchImportWireResult>(
    result,
    (value) => libraryImportReportSchema.safeParse(value).success,
  );
}

export async function exportLibraryItems(
  request: ExportLibraryItemsRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryExportResult> {
  if (!exportLibraryItemsRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_export_many", { request });
  return decodeLibraryResult<LibraryExportWireResult>(result, (value) => {
    const parsed = libraryExportReportSchema.safeParse(value);
    if (!parsed.success) {
      return false;
    }

    const requestedIds = new Set(request.ids);
    const reportedIds = new Set(parsed.data.outcomes.map(({ itemId }) => itemId));
    return (
      parsed.data.outcomes.every(({ itemId }) => requestedIds.has(itemId)) &&
      request.ids.every((id) => reportedIds.has(id))
    );
  });
}

export async function attachLibraryFormat(
  id: string,
  sourcePath: string,
  mode: LibraryFormatAttachMode,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryAttachFormatResult> {
  const result = await invokeCommand<unknown>("library_attach_format", {
    id,
    sourcePath,
    mode,
  });
  return decodeLibraryResult<LibraryStoreResult<{ readonly item: LibraryItem | null }>>(
    result,
    (value) => isItemValue(value, true),
  );
}

export async function removeLibraryFormat(
  id: string,
  format: FormatId,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryRemoveFormatResult> {
  const result = await invokeCommand<unknown>("library_remove_format", { id, format });
  return decodeLibraryResult<LibraryRemoveWireResult>(result, isRemoveValue);
}

export async function replaceLibraryFormat(
  request: ReplaceLibraryFormatRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryReplaceFormatResult> {
  if (!replaceLibraryFormatRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_replace_format", { request });
  return decodeLibraryResult<LibraryReplaceFormatWireResult>(result, isRemoveValue);
}

export async function updateLibraryItem(
  id: string,
  patch: LibraryMetadataPatch,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryUpdateResult> {
  const result = await invokeCommand<unknown>("library_update", { id, patch });
  return decodeLibraryResult<LibraryUpdateWireResult>(result, (value) =>
    isItemValue(value, true),
  );
}

export async function searchLibraryItems(
  query: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibrarySearchResult> {
  const result = await invokeCommand<unknown>("library_search", { query });
  return decodeLibraryResult<LibrarySearchWireResult>(result, isItemsValue);
}

export async function queryLibraryItems(
  request: QueryLibraryItemsRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryQueryResult> {
  if (!queryLibraryItemsRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_query", { request });
  return decodeLibraryResult<LibraryQueryWireResult>(result, (value) => {
    const parsed = libraryQueryPageSchema.safeParse(value);
    return (
      parsed.success &&
      parsed.data.page.offset === request.page.offset &&
      parsed.data.page.limit === request.page.limit
    );
  });
}

export async function listDuplicateCandidates(
  request: ListDuplicateCandidatesRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryDuplicateCandidatesResult> {
  if (!listDuplicateCandidatesRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_duplicates_list", { request });
  return decodeLibraryResult<LibraryDuplicateCandidatesWireResult>(result, (value) => {
    const parsed = duplicateCandidatePageSchema.safeParse(value);
    return (
      parsed.success &&
      parsed.data.page.offset === request.page.offset &&
      parsed.data.page.limit === request.page.limit
    );
  });
}

export async function keepDuplicatePair(
  request: KeepDuplicatePairRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryDuplicateDispositionResult> {
  if (!keepDuplicatePairRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_duplicates_keep", { request });
  return decodeLibraryResult<LibraryDuplicateDispositionWireResult>(
    result,
    (value) => value === null,
  );
}

export async function reopenDuplicatePair(
  request: ReopenDuplicatePairRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryDuplicateDispositionResult> {
  if (!reopenDuplicatePairRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_duplicates_reopen", { request });
  return decodeLibraryResult<LibraryDuplicateDispositionWireResult>(
    result,
    (value) => value === null,
  );
}

export async function mergeDuplicatePair(
  request: MergeDuplicatePairRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryDuplicateMergeResult> {
  if (!mergeDuplicatePairRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_duplicates_merge", { request });
  return decodeLibraryResult<LibraryDuplicateMergeWireResult>(result, (value) =>
    isDuplicateMergeValue(value, request.targetId, request.sourceId),
  );
}

export async function listLibraryTrash(
  request: ListLibraryTrashRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryTrashListResult> {
  if (!listLibraryTrashRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_trash_list", { request });
  return decodeLibraryResult<LibraryTrashListWireResult>(result, (value) => {
    const parsed = libraryTrashPageSchema.safeParse(value);
    return (
      parsed.success &&
      parsed.data.page.offset === request.page.offset &&
      parsed.data.page.limit === request.page.limit
    );
  });
}

export async function trashLibraryItem(
  request: TrashLibraryItemRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryTrashResult> {
  if (!trashLibraryItemRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_trash", { request });
  return decodeLibraryResult<LibraryTrashWireResult>(result, isStrictItemValue);
}

export async function restoreLibraryItem(
  request: RestoreLibraryItemRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryRestoreResult> {
  if (!restoreLibraryItemRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_restore", { request });
  return decodeLibraryResult<LibraryRestoreWireResult>(result, isStrictItemValue);
}

export async function purgeLibraryItem(
  request: PurgeLibraryItemRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryPurgeResult> {
  if (!purgeLibraryItemRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_purge", { request });
  return decodeLibraryResult<LibraryPurgeWireResult>(result, isStrictCleanupValue);
}

export async function listSavedLibraryViews(
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibrarySavedViewsResult> {
  const result = await invokeCommand<unknown>("library_saved_views_list");
  return decodeLibraryResult<LibrarySavedViewsWireResult>(result, isSavedViewsValue);
}

export async function saveSavedLibraryView(
  request: SaveSavedLibraryViewRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibrarySavedViewResult> {
  if (!saveSavedLibraryViewRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_saved_view_save", { request });
  return decodeLibraryResult<LibrarySavedViewWireResult>(result, (value) =>
    isSavedViewValue(value, false),
  );
}

export async function removeSavedLibraryView(
  request: RemoveSavedLibraryViewRequest,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibrarySavedViewResult> {
  if (!removeSavedLibraryViewRequestSchema.safeParse(request).success) {
    return invalidArguments();
  }

  const result = await invokeCommand<unknown>("library_saved_view_remove", { request });
  return decodeLibraryResult<LibrarySavedViewWireResult>(result, (value) =>
    isSavedViewValue(value, true),
  );
}

export async function setLibraryCover(
  id: string,
  sourcePath: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryCoverResult> {
  const result = await invokeCommand<unknown>("library_cover_set", {
    id,
    sourcePath,
  });
  return decodeLibraryResult<LibraryCoverWireResult>(result, (value) =>
    isItemValue(value, true),
  );
}

export async function removeLibraryCover(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryCoverResult> {
  const result = await invokeCommand<unknown>("library_cover_remove", { id });
  return decodeLibraryResult<LibraryCoverWireResult>(result, (value) =>
    isItemValue(value, true),
  );
}

export async function removeLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryRemoveResult> {
  const result = await invokeCommand<unknown>("library_remove", { id });
  return decodeLibraryResult<LibraryRemoveWireResult>(result, isRemoveValue);
}

export async function openLibraryItem(
  id: string,
  format: FormatId,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryOpenResult> {
  const result = await invokeCommand<unknown>("library_open", { id, format });
  return decodeLibraryResult<DesktopLibraryOpenResult>(result, (value) =>
    Boolean(
      isRecord(value) &&
        value.id === id &&
        isFormatId(value.format) &&
        value.format === format &&
        typeof value.path === "string" &&
        value.path.length > 0,
    ),
  );
}

export function parseLibraryTags(value: string): readonly string[] {
  return value.trim() === "" ? [] : normalizeTags(value.split(","));
}

export function describeLibraryError(code: string): string {
  switch (code) {
    case "invalid-arguments":
      return "That file or metadata could not be used.";
    case "invalid-stored-data":
      return "The library contains data Takio cannot read.";
    case "incompatible-schema":
      return "This library was created by an incompatible Takio version.";
    case "duplicate-id":
      return "That item already exists in the library.";
    case "duplicate-format":
      return "This item already has that format.";
    case "last-format":
      return "The item’s only format cannot be removed.";
    case "engine-unavailable":
      return "The local library engine is unavailable.";
    case "protocol-error":
      return "The local library returned an invalid response.";
    case "not-found":
      return "That library item no longer exists.";
    case "missing-file":
      return "The library item’s source file is missing.";
    case "format-mismatch":
      return "The source file no longer matches its library format.";
    case "format-not-found":
      return "That format is no longer available for this item.";
    case "open-failed":
      return "The source file could not be opened.";
    case "stale-review":
      return "This duplicate pair changed. Close and reopen duplicate review before deciding.";
    default:
      return "The local library is unavailable.";
  }
}

export function describeUnexpectedLibraryError(_error: unknown): string {
  return "The local library is unavailable.";
}
