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
