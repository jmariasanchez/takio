import { invoke } from "@tauri-apps/api/core";
import { libraryItemSchema, normalizeTags } from "@takio/core";
import type {
  LibraryCoverWireResult,
  LibraryImportWireResult,
  LibraryListWireResult,
  LibraryMetadataPatch,
  LibraryRemoveWireResult,
  LibrarySearchWireResult,
  LibraryUpdateWireResult,
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
export type DesktopLibraryRemoveResult = LibraryRemoveWireResult | LibraryBridgeFailure;
export type DesktopLibraryUpdateResult = LibraryUpdateWireResult | LibraryBridgeFailure;
export type DesktopLibraryCoverResult = LibraryCoverWireResult | LibraryBridgeFailure;
export type DesktopLibrarySearchResult = LibrarySearchWireResult | LibraryBridgeFailure;
export type DesktopLibraryOpenResult =
  | {
      readonly ok: true;
      readonly value: { readonly id: string; readonly path: string };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string };
    };

export type LibraryInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const invokeTauri: LibraryInvoker = (command, args) => invoke(command, args);

function protocolError(): LibraryBridgeFailure {
  return { ok: false, error: { code: "protocol-error" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function updateLibraryItem(
  id: string,
  patch: LibraryMetadataPatch,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryUpdateResult> {
  const result = await invokeCommand<unknown>("library_update", {
    id,
    title: patch.title,
    author: patch.author === null ? "" : patch.author,
    description: patch.description === null ? "" : patch.description,
    tags: [...patch.tags],
  });
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
  return decodeLibraryResult<LibraryRemoveWireResult>(result, (value) =>
    isItemValue(value, true),
  );
}

export async function openLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryOpenResult> {
  const result = await invokeCommand<unknown>("library_open", { id });
  return decodeLibraryResult<DesktopLibraryOpenResult>(result, (value) =>
    Boolean(
      isRecord(value) &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
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
    case "open-failed":
      return "The source file could not be opened.";
    default:
      return "The local library is unavailable.";
  }
}

export function describeUnexpectedLibraryError(_error: unknown): string {
  return "The local library is unavailable.";
}
