import { expect, test } from "bun:test";

import {
  describeLibraryError,
  describeUnexpectedLibraryError,
  importLibraryItem,
  listLibraryItems,
  parseLibraryTags,
  removeLibraryCover,
  removeLibraryItem,
  searchLibraryItems,
  setLibraryCover,
  updateLibraryItem,
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
  await updateLibraryItem(
    "item-1",
    {
      title: "A new title",
      author: null,
      description: "A description",
      tags: ["Classic", "Science Fiction"],
    },
    invokeCommand,
  );
  await searchLibraryItems("classic", invokeCommand);
  await setLibraryCover("item-1", "/Pictures/A cover.jpg", invokeCommand);
  await removeLibraryCover("item-1", invokeCommand);
  await removeLibraryItem("item-1", invokeCommand);

  expect(calls).toEqual([
    { command: "library_list", args: undefined },
    { command: "library_import", args: { sourcePath: "/Books/A title.epub" } },
    {
      command: "library_update",
      args: {
        id: "item-1",
        title: "A new title",
        author: "",
        description: "A description",
        tags: ["Classic", "Science Fiction"],
      },
    },
    { command: "library_search", args: { query: "classic" } },
    {
      command: "library_cover_set",
      args: { id: "item-1", sourcePath: "/Pictures/A cover.jpg" },
    },
    { command: "library_cover_remove", args: { id: "item-1" } },
    { command: "library_remove", args: { id: "item-1" } },
  ]);
});

test("normalizes comma-separated tags and rejects ambiguous replacements", () => {
  expect(parseLibraryTags("  Science   Fiction, Classic ")).toEqual([
    "Science Fiction",
    "Classic",
  ]);
  expect(parseLibraryTags("  ")).toEqual([]);
  expect(() => parseLibraryTags("Classic, classic")).toThrow();
  expect(() => parseLibraryTags("Classic,")).toThrow();
});

test("gives boundary and storage failures specific user-facing messages", () => {
  expect(describeLibraryError("invalid-arguments")).toBe(
    "That file or metadata could not be used.",
  );
  expect(describeLibraryError("engine-unavailable")).toBe(
    "The local library engine is unavailable.",
  );
  expect(describeLibraryError("storage-unavailable")).toBe(
    "The local library is unavailable.",
  );
});

test("does not expose unexpected implementation details in user-facing errors", () => {
  const implementationDetail = "Cannot read properties of undefined (reading 'invoke')";
  const message = describeUnexpectedLibraryError(new Error(implementationDetail));

  expect(message).toBe("The local library is unavailable.");
  expect(message).not.toContain(implementationDetail);
});
