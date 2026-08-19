import { expect, test } from "bun:test";

import {
  describeDestinationError,
  decodeDestinationSendResult,
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
  const sha256 = "a".repeat(64);
  const validEntry = {
    itemId: "item-1",
    relativePath: "Books/Title.epub",
    bytes: 12,
    sha256,
    format: "epub",
    timestamp: "2026-08-19T00:00:00.000Z",
    status: "present",
  } as const;
  expect(
    decodeDestinationInventoryResult({
      ok: true,
      value: {
        destinationId: "Reader",
        entries: [validEntry],
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
          sha256,
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

  for (const entry of [
    { ...validEntry, itemId: "" },
    { ...validEntry, relativePath: "" },
    { ...validEntry, relativePath: "/Books/Title.epub" },
    { ...validEntry, relativePath: "Books/../Title.epub" },
    { ...validEntry, bytes: -1 },
    { ...validEntry, bytes: 1.5 },
    { ...validEntry, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...validEntry, sha256: "not-a-sha" },
    { ...validEntry, sha256: "A".repeat(64) },
    { ...validEntry, format: "unknown" },
    { ...validEntry, timestamp: "not-a-date" },
    { ...validEntry, status: "removed" },
    { ...validEntry, extra: "unexpected" },
  ]) {
    expect(
      decodeDestinationInventoryResult({
        ok: true,
        value: { destinationId: "Reader", entries: [entry] },
      }),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }

  for (const result of [
    { ok: true, value: { destinationId: "", entries: [validEntry] } },
    { ok: true, value: { destinationId: "Reader", entries: [validEntry], extra: true } },
    { ok: true, value: { destinationId: "Reader", entries: [validEntry] }, extra: true },
  ]) {
    expect(decodeDestinationInventoryResult(result)).toEqual({
      ok: false,
      error: { code: "protocol-error" },
    });
  }
});

test("strictly decodes reader send results", () => {
  const sha256 = "b".repeat(64);
  expect(decodeDestinationSendResult({
    ok: true,
    value: {
      itemId: "item-1",
      destinationId: "Reader",
      path: "/Volumes/Reader/Books/Title.pdf",
      bytes: 42,
      sha256,
      format: "pdf",
      converted: true,
    },
  })).toEqual({
    ok: true,
    value: {
      itemId: "item-1",
      destinationId: "Reader",
      path: "/Volumes/Reader/Books/Title.pdf",
      bytes: 42,
      sha256,
      format: "pdf",
      converted: true,
    },
  });

  for (const result of [
    { ok: true, value: { itemId: "", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "", path: "/p", bytes: 1, sha256, format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "", bytes: 1, sha256, format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: -1, sha256, format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1.5, sha256, format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256: "B".repeat(64), format: "pdf", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "unknown", converted: false } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "pdf", converted: "true" } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "pdf" } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "pdf", converted: false, extra: true } },
    { ok: true, value: { itemId: "item-1", destinationId: "Reader", path: "/p", bytes: 1, sha256, format: "pdf", converted: false }, extra: true },
  ]) {
    expect(decodeDestinationSendResult(result)).toEqual({
      ok: false,
      error: { code: "protocol-error" },
    });
  }
});

test("rejects a valid send response for another item or format", async () => {
  const result = {
    ok: true,
    value: {
      itemId: "another-item",
      destinationId: "Reader",
      path: "/Volumes/Reader/Books/Title.epub",
      bytes: 42,
      sha256: "b".repeat(64),
      format: "epub",
      converted: false,
    },
  } as const;
  const invokeCommand: DestinationInvoker = async () => result as never;

  expect(
    await sendLibraryItem("item-1", "epub", "/Volumes/Reader", false, invokeCommand),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });
  expect(
    await sendLibraryItem("another-item", "pdf", "/Volumes/Reader", true, invokeCommand),
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
