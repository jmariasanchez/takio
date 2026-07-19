import { invoke } from "@tauri-apps/api/core";
import { normalizeTags } from "@takio/core";
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

export function listLibraryItems(
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryListResult> {
  return invokeCommand("library_list");
}

export function importLibraryItem(
  sourcePath: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryImportResult> {
  return invokeCommand("library_import", { sourcePath });
}

export function updateLibraryItem(
  id: string,
  patch: LibraryMetadataPatch,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryUpdateResult> {
  return invokeCommand("library_update", {
    id,
    title: patch.title,
    author: patch.author === null ? "" : patch.author,
    description: patch.description === null ? "" : patch.description,
    tags: [...patch.tags],
  });
}

export function searchLibraryItems(
  query: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibrarySearchResult> {
  return invokeCommand("library_search", { query });
}

export function setLibraryCover(
  id: string,
  sourcePath: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryCoverResult> {
  return invokeCommand("library_cover_set", { id, sourcePath });
}

export function removeLibraryCover(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryCoverResult> {
  return invokeCommand("library_cover_remove", { id });
}

export function removeLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryRemoveResult> {
  return invokeCommand("library_remove", { id });
}

export function openLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryOpenResult> {
  return invokeCommand("library_open", { id });
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
    default:
      return "The local library is unavailable.";
  }
}

export function describeUnexpectedLibraryError(_error: unknown): string {
  return "The local library is unavailable.";
}
