import { describe, expect, it } from "bun:test";

import {
  LIBRARY_STORE_ERROR_CODES,
  type AddLibraryItemRequest,
  type AttachLibraryFormatRequest,
  type ImportLibraryItemRequest,
  type LibraryImportWireResult,
  type LibraryListWireResult,
  type LibraryMetadataPatch,
  type LibraryRemoveWireResult,
  type LibraryStore,
  type LibraryStoreResult,
  type RemoveLibraryFormatRequest,
  type RemoveLibraryFormatResult,
  type RemoveLibraryItemResult,
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
      provenance: "managed",
    },
    {
      sourcePath: "library/left-hand.pdf",
      format: "pdf",
      addedAt: "2026-07-19T12:00:00.000Z",
      provenance: "referenced",
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
      import: async () => ({ ok: true, value: canonicalItem }),
      attachFormat: async () => ({ ok: true, value: null }),
      removeFormat: async () => ({
        ok: true,
        value: { item: null, cleanupPending: false },
      }),
      update: async () => ({ ok: true, value: null }),
      setCover: async () => ({ ok: true, value: null }),
      removeCover: async () => ({ ok: true, value: null }),
      search: async () => ({ ok: true, value: [] }),
      remove: async () => ({ ok: true, value: { item: null, cleanupPending: false } }),
    };

    await expect(store.open({ config: {} })).resolves.toEqual({ ok: true, value: null });
    await expect(store.get({ id: "missing" })).resolves.toEqual({ ok: true, value: null });
    await expect(
      store.attachFormat({
        id: "missing",
        source: { kind: "reference", path: "/external/book.pdf" },
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(store.removeFormat({ id: "missing", format: "pdf" })).resolves.toEqual({
      ok: true,
      value: { item: null, cleanupPending: false },
    });
    await expect(store.remove({ id: "missing" })).resolves.toEqual({
      ok: true,
      value: { item: null, cleanupPending: false },
    });
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
      "invalid-arguments",
      "duplicate-format",
      "last-format",
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
    const removed: LibraryRemoveWireResult = {
      ok: true,
      value: { item: null, cleanupPending: false },
    };

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

  it("keeps format ownership explicit in public items", () => {
    if (false) {
      const { provenance: _provenance, ...formatWithoutProvenance } = canonicalItem.formats[0];
      const itemWithoutProvenance = {
        ...canonicalItem,
        formats: [formatWithoutProvenance],
      };
      // @ts-expect-error Every public book format must declare its ownership provenance.
      const invalidAdd: AddLibraryItemRequest = { item: itemWithoutProvenance };
      expect(invalidAdd).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify(canonicalItem))).toEqual(canonicalItem);
  });

  it("keeps import and format mutation intent explicit and JSON-safe", () => {
    const imported: ImportLibraryItemRequest = {
      sourcePath: "/external/left-hand.epub",
      title: "The Left Hand of Darkness",
    };
    const attached: AttachLibraryFormatRequest = {
      id: canonicalItem.id,
      source: { kind: "reference", path: "/external/left-hand.pdf" },
    };
    const removed: RemoveLibraryFormatRequest = { id: canonicalItem.id, format: "pdf" };

    if (false) {
      // @ts-expect-error Managed import destination is owned by the store, not the caller.
      const invalidImport: ImportLibraryItemRequest = {
        sourcePath: "/external/left-hand.epub",
        destinationPath: "/chosen/by/caller.epub",
      };
      // @ts-expect-error Persisted provenance is derived by the store from copy/reference intent.
      const invalidAttach: AttachLibraryFormatRequest = {
        id: canonicalItem.id,
        source: { kind: "managed", path: "/external/left-hand.pdf" },
      };
      expect([invalidImport, invalidAttach]).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify({ imported, attached, removed }))).toEqual({
      imported,
      attached,
      removed,
    });
  });

  it("requires cleanup status on whole-item and format removal results", () => {
    const itemRemoval: RemoveLibraryItemResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: true },
    };
    const formatRemoval: RemoveLibraryFormatResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: false },
    };

    if (false) {
      // @ts-expect-error Cleanup status cannot be omitted from whole-item removal.
      const incompleteItemRemoval: RemoveLibraryItemResult = {
        ok: true,
        value: { item: canonicalItem },
      };
      // @ts-expect-error Cleanup status cannot be omitted from format removal.
      const incompleteFormatRemoval: RemoveLibraryFormatResult = {
        ok: true,
        value: { item: canonicalItem },
      };
      expect([incompleteItemRemoval, incompleteFormatRemoval]).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify({ itemRemoval, formatRemoval }))).toEqual({
      itemRemoval,
      formatRemoval,
    });
  });
});
