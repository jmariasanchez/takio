import { expect, test } from "bun:test";

import {
  attachLibraryFormat,
  describeLibraryError,
  describeUnexpectedLibraryError,
  importLibraryItem,
  listLibraryItems,
  openLibraryItem,
  parseLibraryTags,
  removeLibraryCover,
  removeLibraryFormat,
  removeLibraryItem,
  searchLibraryItems,
  setLibraryCover,
  updateLibraryItem,
  type LibraryInvoker,
} from "./library";

const validItem = {
  id: "item-1",
  title: "A title",
  sourcePath: "/Books/A title.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [
    {
      sourcePath: "/Books/A title.epub",
      format: "epub",
      addedAt: "2026-07-18T12:00:00.000Z",
      provenance: "managed",
    },
    {
      sourcePath: "/Books/A title.pdf",
      format: "pdf",
      addedAt: "2026-07-19T10:00:00.000Z",
      provenance: "referenced",
    },
  ],
  author: "An author",
  description: "A description",
  coverPath: "/Covers/item-1.jpg",
  tags: ["Classic"],
  updatedAt: "2026-07-19T12:00:00.000Z",
} as const;

test("uses only the fixed desktop library commands and argument names", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: LibraryInvoker = async (command, args) => {
    calls.push({ command, args });
    if (command === "library_list") {
      return { ok: true, value: { items: [] } } as never;
    }
    if (command === "library_open") {
      return {
        ok: true,
        value: { id: "item-1", path: "/Books/A title.epub" },
      } as never;
    }
    if (command === "library_remove") {
      return {
        ok: true,
        value: { item: null, cleanupPending: false },
      } as never;
    }
    if (command === "library_attach_format") {
      return { ok: true, value: { item: validItem } } as never;
    }
    if (command === "library_remove_format") {
      return {
        ok: true,
        value: { item: null, cleanupPending: false },
      } as never;
    }
    return { ok: true, value: { item: null } } as never;
  };

  await listLibraryItems(invokeCommand);
  await importLibraryItem("/Books/A title.epub", invokeCommand);
  await attachLibraryFormat(
    "item-1",
    "/Books/A title.pdf",
    "copy",
    invokeCommand,
  );
  await attachLibraryFormat(
    "item-1",
    "/Books/A title.mobi",
    "reference",
    invokeCommand,
  );
  await removeLibraryFormat("item-1", "pdf", invokeCommand);
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
  await openLibraryItem("item-1", invokeCommand);

  expect(calls).toEqual([
    { command: "library_list", args: undefined },
    { command: "library_import", args: { sourcePath: "/Books/A title.epub" } },
    {
      command: "library_attach_format",
      args: {
        id: "item-1",
        sourcePath: "/Books/A title.pdf",
        mode: "copy",
      },
    },
    {
      command: "library_attach_format",
      args: {
        id: "item-1",
        sourcePath: "/Books/A title.mobi",
        mode: "reference",
      },
    },
    {
      command: "library_remove_format",
      args: { id: "item-1", format: "pdf" },
    },
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
    { command: "library_open", args: { id: "item-1" } },
  ]);
});

test("passes valid library responses through with authoritative format order", async () => {
  const listResult = { ok: true, value: { items: [validItem] } } as const;
  const importResult = { ok: true, value: { item: validItem } } as const;
  const removeResult = {
    ok: true,
    value: { item: null, cleanupPending: true },
  } as const;
  const openResult = {
    ok: true,
    value: { id: validItem.id, path: validItem.sourcePath },
  } as const;

  const decodedList = await listLibraryItems(async () => listResult as never);

  expect(decodedList).toBe(listResult);
  expect(
    decodedList.ok
      ? decodedList.value.items[0]?.formats.map(({ format, provenance }) => ({
          format,
          provenance,
        }))
      : [],
  ).toEqual([
    { format: "epub", provenance: "managed" },
    { format: "pdf", provenance: "referenced" },
  ]);
  expect(
    await importLibraryItem(validItem.sourcePath, async () => importResult as never),
  ).toBe(importResult);
  expect(
    await attachLibraryFormat(
      validItem.id,
      "/Books/A title.mobi",
      "reference",
      async () => importResult as never,
    ),
  ).toBe(importResult);
  expect(
    await removeLibraryFormat(validItem.id, "pdf", async () => removeResult as never),
  ).toBe(removeResult);
  expect(await removeLibraryItem(validItem.id, async () => removeResult as never)).toBe(
    removeResult,
  );
  expect(await openLibraryItem(validItem.id, async () => openResult as never)).toBe(
    openResult,
  );
});

test("requires explicit cleanup state after removing a library item", async () => {
  for (const value of [
    { item: null },
    { item: null, cleanupPending: "no" },
    { item: { ...validItem, formats: [] }, cleanupPending: false },
  ]) {
    expect(
      await removeLibraryItem(validItem.id, async () => ({
        ok: true,
        value,
      }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("rejects malformed format lifecycle success payloads", async () => {
  for (const value of [
    { item: null },
    {},
    { item: { ...validItem, formats: [] } },
  ]) {
    expect(
      await attachLibraryFormat(
        validItem.id,
        "/Books/A title.mobi",
        "reference",
        async () => ({ ok: true, value }) as never,
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }

  for (const value of [
    { item: null },
    { item: null, cleanupPending: "no" },
    { item: { ...validItem, formats: [] }, cleanupPending: false },
  ]) {
    expect(
      await removeLibraryFormat(validItem.id, "pdf", async () => ({
        ok: true,
        value,
      }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("rejects malformed nested and scalar library response values", async () => {
  const { formats: _formats, ...itemWithoutFormats } = validItem;
  const malformedResults = [
    { ok: true, value: { items: [{ ...validItem, tags: "Classic" }] } },
    { ok: true, value: { items: [{ ...validItem, format: "mp3" }] } },
    { ok: true, value: { items: [itemWithoutFormats] } },
    { ok: true, value: { items: [{ ...validItem, formats: "epub" }] } },
    { ok: true, value: { items: [{ ...validItem, formats: [] }] } },
    {
      ok: true,
      value: {
        items: [
          {
            ...validItem,
            formats: [validItem.formats[0], { ...validItem.formats[1], format: "epub" }],
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        items: [
          {
            ...validItem,
            formats: validItem.formats.map(({ provenance: _provenance, ...format }) =>
              format,
            ),
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        items: [
          {
            ...validItem,
            formats: [
              validItem.formats[0],
              { ...validItem.formats[1], provenance: "borrowed" },
            ],
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        items: [
          {
            ...validItem,
            formats: [{ ...validItem.formats[0], addedAt: "yesterday" }],
          },
        ],
      },
    },
    {
      ok: true,
      value: {
        items: [
          {
            ...validItem,
            formats: [
              {
                sourcePath: "/Books/A title.pdf",
                format: "pdf",
                addedAt: validItem.addedAt,
                provenance: "managed",
              },
            ],
          },
        ],
      },
    },
    { ok: false, error: { code: 42 } },
  ];

  for (const result of malformedResults) {
    expect(await listLibraryItems(async () => result as never)).toEqual({
      ok: false,
      error: { code: "protocol-error" },
    });
  }

  expect(
    await importLibraryItem(validItem.sourcePath, async () => ({
      ok: true,
      value: { item: { ...validItem, addedAt: "yesterday" } },
    }) as never),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });

  expect(
    await openLibraryItem(validItem.id, async () => ({
      ok: true,
      value: { id: validItem.id, path: 42 },
    }) as never),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });
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
  expect(describeLibraryError("duplicate-format")).toBe(
    "This item already has that format.",
  );
  expect(describeLibraryError("last-format")).toBe(
    "The item’s only format cannot be removed.",
  );
  expect(describeLibraryError("storage-unavailable")).toBe(
    "The local library is unavailable.",
  );
  expect(describeLibraryError("missing-file")).toBe(
    "The library item’s source file is missing.",
  );
  expect(describeLibraryError("format-mismatch")).toBe(
    "The source file no longer matches its library format.",
  );
  expect(describeLibraryError("open-failed")).toBe(
    "The source file could not be opened.",
  );
});

test("does not expose unexpected implementation details in user-facing errors", () => {
  const implementationDetail = "Cannot read properties of undefined (reading 'invoke')";
  const message = describeUnexpectedLibraryError(new Error(implementationDetail));

  expect(message).toBe("The local library is unavailable.");
  expect(message).not.toContain(implementationDetail);
});
