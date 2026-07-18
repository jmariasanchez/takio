import { expect, test } from "bun:test";

import {
  describeLibraryError,
  importLibraryItem,
  listLibraryItems,
  removeLibraryItem,
  type LibraryInvoker,
} from "./library";

test("uses only the fixed desktop library commands and argument names", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: LibraryInvoker = async (command, args) => {
    calls.push({ command, args });
    if (command === "library_list") {
      return { ok: true, value: { items: [] } } as never;
    }
    return { ok: true, value: { item: null } } as never;
  };

  await listLibraryItems(invokeCommand);
  await importLibraryItem("/Books/A title.epub", invokeCommand);
  await removeLibraryItem("item-1", invokeCommand);

  expect(calls).toEqual([
    { command: "library_list", args: undefined },
    { command: "library_import", args: { sourcePath: "/Books/A title.epub" } },
    { command: "library_remove", args: { id: "item-1" } },
  ]);
});

test("gives boundary and storage failures specific user-facing messages", () => {
  expect(describeLibraryError("invalid-arguments")).toBe("That file could not be imported.");
  expect(describeLibraryError("engine-unavailable")).toBe(
    "The local library engine is unavailable.",
  );
  expect(describeLibraryError("storage-unavailable")).toBe(
    "The local library is unavailable.",
  );
});
