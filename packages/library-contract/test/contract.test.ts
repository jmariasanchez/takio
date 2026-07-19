import { describe, expect, it } from "bun:test";

import {
  LIBRARY_STORE_ERROR_CODES,
  type AddLibraryItemRequest,
  type LibraryImportWireResult,
  type LibraryListWireResult,
  type LibraryMetadataPatch,
  type LibraryRemoveWireResult,
  type LibraryStore,
  type LibraryStoreResult,
} from "../src/index.js";

const canonicalItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [
    {
      sourcePath: "library/left-hand.epub",
      format: "epub",
      addedAt: "2026-07-17T12:00:00.000Z",
    },
    {
      sourcePath: "library/left-hand.pdf",
      format: "pdf",
      addedAt: "2026-07-19T12:00:00.000Z",
    },
  ],
  tags: [],
} as const;

describe("LibraryStore", () => {
  it("keeps missing records JSON-safe across asynchronous boundaries", async () => {
    const store: LibraryStore = {
      open: async () => ({ ok: true, value: null }),
      list: async () => ({ ok: true, value: [] }),
      get: async () => ({ ok: true, value: null }),
      add: async ({ item }) => ({ ok: true, value: item }),
      update: async () => ({ ok: true, value: null }),
      setCover: async () => ({ ok: true, value: null }),
      removeCover: async () => ({ ok: true, value: null }),
      search: async () => ({ ok: true, value: [] }),
      remove: async () => ({ ok: true, value: null }),
    };

    await expect(store.open({ config: {} })).resolves.toEqual({ ok: true, value: null });
    await expect(store.get({ id: "missing" })).resolves.toEqual({ ok: true, value: null });
    await expect(store.remove({ id: "missing" })).resolves.toEqual({ ok: true, value: null });
  });

  it("limits metadata edits to display fields and complete tag replacement", () => {
    const patch: LibraryMetadataPatch = {
      title: "Kindred",
      author: null,
      description: "A novel",
      tags: ["Classic"],
    };

    if (false) {
      // @ts-expect-error Source identity is immutable through metadata updates.
      const invalid: LibraryMetadataPatch = { tags: [], sourcePath: "elsewhere.epub" };
      expect(invalid).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
  });

  it("publishes driver-independent error codes", () => {
    expect(LIBRARY_STORE_ERROR_CODES).toEqual([
      "duplicate-id",
      "invalid-stored-data",
      "storage-unavailable",
      "incompatible-schema",
    ]);

    const result: LibraryStoreResult<never> = {
      ok: false,
      error: { code: "storage-unavailable" },
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps desktop wire results explicit and JSON-safe", () => {
    const listed: LibraryListWireResult = {
      ok: true,
      value: { items: [canonicalItem] },
    };
    const imported: LibraryImportWireResult = {
      ok: true,
      value: { item: canonicalItem },
    };
    const removed: LibraryRemoveWireResult = { ok: true, value: { item: null } };

    expect(JSON.parse(JSON.stringify({ listed, imported, removed }))).toEqual({
      listed,
      imported,
      removed,
    });
  });

  it("requires the authoritative format aggregate on add and wire items", () => {
    const request: AddLibraryItemRequest = { item: canonicalItem };

    if (false) {
      const { formats: _formats, ...scalarOnlyItem } = canonicalItem;
      // @ts-expect-error Scalar aliases alone are not a complete public library item.
      const invalidRequest: AddLibraryItemRequest = { item: scalarOnlyItem };
      // @ts-expect-error Desktop wire items require the authoritative format aggregate too.
      const invalidWire: LibraryListWireResult = {
        ok: true,
        value: { items: [scalarOnlyItem] },
      };
      expect([invalidRequest, invalidWire]).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(request.item.addedAt).not.toBe(request.item.formats[0]?.addedAt);
  });
});
