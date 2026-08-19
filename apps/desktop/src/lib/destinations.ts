import { FORMAT_CATALOG, type Destination, type FormatId } from "@takio/core";
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

const inventoryEntryKeys = [
  "bytes",
  "format",
  "itemId",
  "relativePath",
  "sha256",
  "status",
  "timestamp",
].sort();
const inventoryResultKeys = ["ok", "value"].sort();
const inventoryResultValueKeys = ["destinationId", "entries"].sort();
const knownFormats = new Set(FORMAT_CATALOG.map(({ id }) => id));

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRelativePath(value: unknown): value is string {
  if (!nonemptyString(value) || value.startsWith("/")) return false;
  return !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function validTimestamp(value: unknown): value is string {
  return nonemptyString(value) && !Number.isNaN(Date.parse(value));
}

export function decodeDestinationInventoryEntry(value: unknown): DestinationInventoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasOnlyKeys(candidate, inventoryEntryKeys) &&
    nonemptyString(candidate.itemId) &&
    safeRelativePath(candidate.relativePath) &&
    typeof candidate.bytes === "number" &&
    Number.isFinite(candidate.bytes) &&
    Number.isInteger(candidate.bytes) &&
    candidate.bytes >= 0 &&
    typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/i.test(candidate.sha256) &&
    typeof candidate.format === "string" && knownFormats.has(candidate.format as FormatId) &&
    validTimestamp(candidate.timestamp) &&
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
  const payload = result.value as Record<string, unknown> | null;
  if (
    result.ok !== true ||
    !hasOnlyKeys(result as Record<string, unknown>, inventoryResultKeys) ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !hasOnlyKeys(payload, inventoryResultValueKeys) ||
    !nonemptyString(payload.destinationId) ||
    !Array.isArray(payload.entries)
  ) {
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
