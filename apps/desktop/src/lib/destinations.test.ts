import { expect, test } from "bun:test";

import {
  describeDestinationError,
  describeUnexpectedDestinationError,
  ejectDestination,
  listDestinations,
  sendLibraryItem,
  type DestinationInvoker,
} from "./destinations";

test("uses only the fixed desktop destination commands and argument names", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: DestinationInvoker = async (command, args) => {
    calls.push({ command, args });
    return { ok: true, value: {} } as never;
  };

  await listDestinations(invokeCommand);
  await sendLibraryItem("item-1", "/Volumes/Reader", invokeCommand);
  await ejectDestination("/Volumes/Reader", invokeCommand);

  expect(calls).toEqual([
    { command: "destination_list", args: undefined },
    {
      command: "destination_send",
      args: { id: "item-1", destinationPath: "/Volumes/Reader" },
    },
    {
      command: "destination_eject",
      args: { destinationPath: "/Volumes/Reader" },
    },
  ]);
});

test("keeps reader collision, availability, verification, and eject failures distinct", () => {
  expect(describeDestinationError("destination-file-exists")).toBe(
    "The destination file already exists on that reader.",
  );
  expect(describeDestinationError("unknown-destination")).toBe(
    "That reader is no longer available.",
  );
  expect(describeDestinationError("verification-failed")).toBe(
    "The copied file could not be verified.",
  );
  expect(describeDestinationError("eject-failed")).toBe(
    "The reader could not be ejected.",
  );
});

test("does not expose unexpected reader implementation details", () => {
  const implementationDetail = "diskutil exited 71: private mount detail";
  const message = describeUnexpectedDestinationError(new Error(implementationDetail));

  expect(message).toBe("The reader operation failed.");
  expect(message).not.toContain(implementationDetail);
});
