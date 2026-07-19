import type { Destination } from "@takio/core";
import { invoke } from "@tauri-apps/api/core";

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

export type DestinationInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const invokeTauri: DestinationInvoker = (command, args) => invoke(command, args);

export function listDestinations(
  invokeCommand: DestinationInvoker = invokeTauri,
): Promise<DesktopDestinationListResult> {
  return invokeCommand("destination_list");
}

export function sendLibraryItem(
  id: string,
  destinationPath: string,
  invokeCommand: DestinationInvoker = invokeTauri,
): Promise<DesktopDestinationSendResult> {
  return invokeCommand("destination_send", { id, destinationPath });
}

export function ejectDestination(
  destinationPath: string,
  invokeCommand: DestinationInvoker = invokeTauri,
): Promise<DesktopDestinationEjectResult> {
  return invokeCommand("destination_eject", { destinationPath });
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
    case "source-unavailable":
      return "The library item’s source file is unavailable.";
    case "destination-file-exists":
      return "The destination file already exists on that reader.";
    case "verification-failed":
      return "The copied file could not be verified.";
    case "copy-failed":
      return "The file could not be copied to that reader.";
    case "engine-unavailable":
      return "The local library engine is unavailable.";
    case "protocol-error":
      return "The local library returned an invalid response.";
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
