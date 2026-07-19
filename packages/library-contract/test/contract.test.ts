import { describe, expect, it } from "bun:test";

import {
  LIBRARY_STORE_ERROR_CODES,
  type LibraryListWireResult,
  type LibraryMetadataPatch,
  type LibraryRemoveWireResult,
  type LibraryStore,
  type LibraryStoreResult,
} from "../src/index.js";

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
    const listed: LibraryListWireResult = { ok: true, value: { items: [] } };
    const removed: LibraryRemoveWireResult = { ok: true, value: { item: null } };

    expect(JSON.parse(JSON.stringify({ listed, removed }))).toEqual({ listed, removed });
  });
});
