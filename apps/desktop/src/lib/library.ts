import { invoke } from "@tauri-apps/api/core";
import { FORMAT_IDS, libraryItemSchema, normalizeTags } from "@takio/core";
import type { FormatId, LibraryItem } from "@takio/core";
import {
  libraryQueryPageSchema,
  queryLibraryItemsRequestSchema,
  removeSavedLibraryViewRequestSchema,
  savedLibraryViewSchema,
  saveSavedLibraryViewRequestSchema,
} from "@takio/library-contract";
import type {
  LibraryCoverWireResult,
  LibraryImportWireResult,
  LibraryListWireResult,
  LibraryMetadataPatch,
  LibraryQueryWireResult,
  LibraryRemoveWireResult,
  LibrarySavedViewWireResult,
  LibrarySavedViewsWireResult,
  LibrarySearchWireResult,
  LibraryStoreResult,
  LibraryUpdateWireResult,
  QueryLibraryItemsRequest,
  RemoveSavedLibraryViewRequest,
  SaveSavedLibraryViewRequest,
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
export type DesktopLibraryImportResult = LibraryImportWireResult | LibraryBridgeFailure;
export type DesktopLibraryAttachFormatResult =
  | LibraryStoreResult<{ readonly item: LibraryItem | null }>
  | LibraryBridgeFailure;
export type DesktopLibraryRemoveFormatResult = LibraryRemoveWireResult | LibraryBridgeFailure;
export type DesktopLibraryRemoveResult = LibraryRemoveWireResult | LibraryBridgeFailure;
export type DesktopLibraryUpdateResult = LibraryUpdateWireResult | LibraryBridgeFailure;
export type DesktopLibraryCoverResult = LibraryCoverWireResult | LibraryBridgeFailure;
export type DesktopLibrarySearchResult = LibrarySearchWireResult | LibraryBridgeFailure;
export type DesktopLibraryQueryResult = LibraryQueryWireResult | LibraryBridgeFailure;
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

function isLibraryItem(value: unknown): boolean {
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

export async function importLibraryItem(
  sourcePath: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryImportResult> {
  const result = await invokeCommand<unknown>("library_import", { sourcePath });
  return decodeLibraryResult<LibraryImportWireResult>(result, (value) =>
    isItemValue(value, false),
  );
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
    default:
      return "The local library is unavailable.";
  }
}

export function describeUnexpectedLibraryError(_error: unknown): string {
  return "The local library is unavailable.";
}
