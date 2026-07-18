import { invoke } from "@tauri-apps/api/core";
import type {
  LibraryImportWireResult,
  LibraryListWireResult,
  LibraryRemoveWireResult,
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

export function removeLibraryItem(
  id: string,
  invokeCommand: LibraryInvoker = invokeTauri,
): Promise<DesktopLibraryRemoveResult> {
  return invokeCommand("library_remove", { id });
}

export function describeLibraryError(code: string): string {
  switch (code) {
    case "invalid-arguments":
      return "That file could not be imported.";
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
