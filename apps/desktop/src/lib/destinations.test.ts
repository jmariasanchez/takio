import { expect, test } from "bun:test";

import {
  describeDestinationError,
  decodeDestinationInventoryResult,
  describeUnexpectedDestinationError,
  ejectDestination,
  inventoryDestination,
  listDestinations,
  reconcileDestination,
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
  await sendLibraryItem("item-1", "pdf", "/Volumes/Reader", true, invokeCommand);
  await ejectDestination("/Volumes/Reader", invokeCommand);
  await inventoryDestination("/Volumes/Reader", invokeCommand);
  await reconcileDestination("/Volumes/Reader", invokeCommand);

  expect(calls).toEqual([
    { command: "destination_list", args: undefined },
    {
      command: "destination_send",
      args: { id: "item-1", format: "pdf", destinationPath: "/Volumes/Reader", convertIfNeeded: true },
    },
    {
      command: "destination_eject",
      args: { destinationPath: "/Volumes/Reader" },
    },
    {
      command: "destination_inventory",
      args: { destinationPath: "/Volumes/Reader" },
    },
    {
      command: "destination_reconcile",
      args: { destinationPath: "/Volumes/Reader" },
    },
  ]);
});

test("strictly decodes reader inventory entries", () => {
  expect(
    decodeDestinationInventoryResult({
      ok: true,
      value: {
        destinationId: "Reader",
        entries: [
          {
            itemId: "item-1",
            relativePath: "Books/Title.epub",
            bytes: 12,
            sha256: "abc",
            format: "epub",
            timestamp: "2026-08-19T00:00:00.000Z",
            status: "present",
          },
        ],
      },
    }),
  ).toEqual({
    ok: true,
    value: {
      destinationId: "Reader",
      entries: [
        {
          itemId: "item-1",
          relativePath: "Books/Title.epub",
          bytes: 12,
          sha256: "abc",
          format: "epub",
          timestamp: "2026-08-19T00:00:00.000Z",
          status: "present",
        },
      ],
    },
  });
  expect(
    decodeDestinationInventoryResult({
      ok: true,
      value: { destinationId: "Reader", entries: [{ itemId: "item-1", status: "removed" }] },
    }),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });
});

test("keeps reader collision, availability, format, verification, and eject failures distinct", () => {
  expect(describeDestinationError("destination-file-exists")).toBe(
    "The destination file already exists on that reader.",
  );
  expect(describeDestinationError("unknown-destination")).toBe(
    "That reader is no longer available.",
  );
  expect(describeDestinationError("format-not-found")).toBe(
    "That format is no longer available for this item.",
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
