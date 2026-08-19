import type { Destination, FormatId } from "@takio/core";
import { invoke } from "./desktop";

export type DestinationFailure = {
  readonly ok: false;
  readonly error: { readonly code: string };
};

export type DesktopDestinationListResult =
  | {
      readonly ok: true;
      readonly value: { readonly destinations: readonly Destination[] };
    }
  | DestinationFailure;

export type DesktopDestinationSendResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly itemId: string;
        readonly destinationId: string;
        readonly path: string;
        readonly bytes: number;
        readonly sha256: string;
      };
    }
  | DestinationFailure;

export type DesktopDestinationEjectResult =
  | {
      readonly ok: true;
      readonly value: { readonly destinationId: string };
    }
  | DestinationFailure;

export type DestinationInventoryStatus = "present" | "missing" | "changed";

export type DestinationInventoryEntry = {
  readonly itemId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: string;
  readonly timestamp: string;
  readonly status: DestinationInventoryStatus;
};

export type DesktopDestinationInventoryResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly destinationId: string;
        readonly entries: readonly DestinationInventoryEntry[];
      };
    }
  | DestinationFailure;

export type DestinationInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const invokeDesktop: DestinationInvoker = (command, args) => invoke(command, args);

export function listDestinations(
  invokeCommand: DestinationInvoker = invokeDesktop,
): Promise<DesktopDestinationListResult> {
  return invokeCommand("destination_list");
}

export function sendLibraryItem(
  id: string,
  format: FormatId,
  destinationPath: string,
  convertIfNeeded: boolean,
  invokeCommand: DestinationInvoker = invokeDesktop,
): Promise<DesktopDestinationSendResult> {
  return invokeCommand("destination_send", { id, format, destinationPath, convertIfNeeded });
}

export function ejectDestination(
  destinationPath: string,
  invokeCommand: DestinationInvoker = invokeDesktop,
): Promise<DesktopDestinationEjectResult> {
  return invokeCommand("destination_eject", { destinationPath });
}

function isInventoryStatus(value: unknown): value is DestinationInventoryStatus {
  return value === "present" || value === "missing" || value === "changed";
}

export function decodeDestinationInventoryEntry(value: unknown): DestinationInventoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.itemId === "string" &&
    typeof candidate.relativePath === "string" &&
    typeof candidate.bytes === "number" &&
    Number.isFinite(candidate.bytes) &&
    typeof candidate.sha256 === "string" &&
    typeof candidate.format === "string" &&
    typeof candidate.timestamp === "string" &&
    isInventoryStatus(candidate.status)
    ? {
        itemId: candidate.itemId,
        relativePath: candidate.relativePath,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
        format: candidate.format,
        timestamp: candidate.timestamp,
        status: candidate.status,
      }
    : null;
}

export function decodeDestinationInventoryResult(value: unknown): DesktopDestinationInventoryResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: { code: "protocol-error" } };
  }
  const result = value as { ok?: unknown; value?: unknown; error?: unknown };
  if (result.ok === false) {
    const error = result.error as { code?: unknown } | null;
    return typeof error?.code === "string"
      ? { ok: false, error: { code: error.code } }
      : { ok: false, error: { code: "protocol-error" } };
  }
  const payload = result.value as { destinationId?: unknown; entries?: unknown } | null;
  if (result.ok !== true || typeof payload?.destinationId !== "string" || !Array.isArray(payload.entries)) {
    return { ok: false, error: { code: "protocol-error" } };
  }
  const entries = payload.entries.map(decodeDestinationInventoryEntry);
  return entries.every((entry): entry is DestinationInventoryEntry => entry !== null)
    ? { ok: true, value: { destinationId: payload.destinationId, entries } }
    : { ok: false, error: { code: "protocol-error" } };
}

export async function inventoryDestination(
  destinationPath: string,
  invokeCommand: DestinationInvoker = invokeDesktop,
): Promise<DesktopDestinationInventoryResult> {
  return decodeDestinationInventoryResult(
    await invokeCommand("destination_inventory", { destinationPath }),
  );
}

export async function reconcileDestination(
  destinationPath: string,
  invokeCommand: DestinationInvoker = invokeDesktop,
): Promise<DesktopDestinationInventoryResult> {
  return decodeDestinationInventoryResult(
    await invokeCommand("destination_reconcile", { destinationPath }),
  );
}

export function describeDestinationError(code: string): string {
  switch (code) {
    case "invalid-arguments":
      return "The selected library item or reader is invalid.";
    case "destination-unavailable":
      return "Takio could not scan mounted readers.";
    case "unknown-destination":
      return "That reader is no longer available.";
    case "unsupported-platform":
      return "Reader eject is only available on macOS.";
    case "eject-failed":
      return "The reader could not be ejected.";
    case "unknown-item":
      return "That library item no longer exists.";
    case "format-not-found":
      return "That format is no longer available for this item.";
    case "source-unavailable":
      return "The library item’s source file is unavailable.";
    case "destination-file-exists":
      return "The destination file already exists on that reader.";
    case "verification-failed":
      return "The copied file could not be verified.";
    case "copy-failed":
      return "The file could not be copied to that reader.";
    case "protocol-error":
      return "The local library returned an invalid response.";
    case "engine-unavailable":
      return "The local library engine is unavailable.";
    case "invalid-stored-data":
      return "The library contains data Takio cannot read.";
    case "storage-unavailable":
      return "The local library is unavailable.";
    case "incompatible-schema":
      return "This library was created by an incompatible Takio version.";
    default:
      return "The reader operation failed.";
  }
}

export function describeUnexpectedDestinationError(_error: unknown): string {
  return "The reader operation failed.";
}
