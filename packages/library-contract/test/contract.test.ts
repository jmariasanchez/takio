import { describe, expect, it } from "bun:test";

import {
  LIBRARY_QUERY_SORT_DIRECTIONS,
  LIBRARY_QUERY_SORT_FIELDS,
  LIBRARY_STORE_ERROR_CODES,
  MAX_LIBRARY_QUERY_PAGE_SIZE,
  MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH,
  type AddLibraryItemRequest,
  type AttachLibraryFormatRequest,
  type ImportLibraryItemRequest,
  type LibraryImportWireResult,
  type LibraryListWireResult,
  type LibraryFormatReplacementStore,
  type LibraryItemTrashStore,
  type LibraryMetadataPatch,
  type LibraryPurgeWireResult,
  type LibraryQueryStore,
  type LibraryReplaceFormatWireResult,
  type LibraryRemoveWireResult,
  type LibraryRestoreWireResult,
  type LibraryTrashListWireResult,
  type LibraryTrashWireResult,
  type ListLibraryTrashResult,
  type PurgeLibraryItemResult,
  type QueryLibraryItemsRequest,
  type RestoreLibraryItemResult,
  type SavedLibraryViewStore,
  type LibraryStore,
  type LibraryStoreResult,
  type RemoveLibraryFormatRequest,
  type RemoveLibraryFormatResult,
  type RemoveLibraryItemResult,
  type ReplaceLibraryFormatRequest,
  type ReplaceLibraryFormatResult,
  type TrashLibraryItemResult,
  libraryMetadataPatchSchema,
  libraryQueryPageSchema,
  libraryTrashPageSchema,
  listLibraryTrashRequestSchema,
  purgeLibraryItemRequestSchema,
  queryLibraryItemsRequestSchema,
  replaceLibraryFormatRequestSchema,
  removeSavedLibraryViewRequestSchema,
  restoreLibraryItemRequestSchema,
  saveSavedLibraryViewRequestSchema,
  savedLibraryViewSchema,
  trashLibraryItemRequestSchema,
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
  it("defines bounded pages, literal queries, rich filters, and deterministic sorts", async () => {
    const request: QueryLibraryItemsRequest = {
      query: 'title:"darkness"',
      filters: {
        authors: ["Ursula K. Le Guin"],
        tags: ["Classic"],
        series: ["Hainish Cycle"],
        languages: ["en"],
        formats: ["epub", "pdf"],
      },
      sort: { field: "title", direction: "ascending" },
      page: { offset: 0, limit: MAX_LIBRARY_QUERY_PAGE_SIZE },
    };
    const queryStore: LibraryQueryStore = {
      query: async (parsedRequest) => ({
        ok: true,
        value: {
          items: [],
          total: 0,
          page: parsedRequest.page,
          facets: { authors: [], tags: [], series: [], languages: [], formats: [] },
        },
      }),
    };

    expect(LIBRARY_QUERY_SORT_FIELDS).toEqual([
      "title",
      "author",
      "series",
      "publishedDate",
      "rating",
      "addedAt",
      "updatedAt",
    ]);
    expect(LIBRARY_QUERY_SORT_DIRECTIONS).toEqual(["ascending", "descending"]);
    expect(queryLibraryItemsRequestSchema.parse(request)).toEqual(request);
    await expect(queryStore.query(request)).resolves.toMatchObject({ ok: true });

    for (const field of ["series", "publishedDate", "rating"] as const) {
      expect(
        queryLibraryItemsRequestSchema.safeParse({ ...request, sort: { ...request.sort, field } })
          .success,
      ).toBe(true);
    }

    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        page: { offset: 0, limit: MAX_LIBRARY_QUERY_PAGE_SIZE + 1 },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        page: { offset: 1e20, limit: 1 },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        filters: { ...request.filters, tags: ["Classic", "classic"] },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        filters: { ...request.filters, series: ["Earthsea", "earthsea"] },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        filters: { ...request.filters, languages: ["en", "EN"] },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        filters: { ...request.filters, languages: ["not_a_tag"] },
      }).success,
    ).toBe(false);
    expect(
      queryLibraryItemsRequestSchema.safeParse({
        ...request,
        sort: { field: "publisher", direction: "ascending" },
      }).success,
    ).toBe(false);

    if (false) {
      // @ts-expect-error Paging is required for database-backed library queries.
      const unpaged: QueryLibraryItemsRequest = {
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
      };
      const unsupportedSort: QueryLibraryItemsRequest = {
        ...request,
        // @ts-expect-error Publisher is not an available library-table sort.
        sort: { field: "publisher", direction: "ascending" },
      };
      expect([unpaged, unsupportedSort]).toBeUndefined();
    }
  });

  it("validates page totals, limits, and library facet values", () => {
    const page = {
      items: [canonicalItem],
      total: 1,
      page: { offset: 0, limit: 1 },
      facets: {
        authors: [{ value: "Ursula K. Le Guin", count: 1 }],
        tags: [{ value: "Classic", count: 1 }],
        series: [{ value: "Hainish Cycle", count: 1 }],
        languages: [{ value: "en", count: 1 }],
        formats: [
          { value: "epub", count: 1 },
          { value: "pdf", count: 1 },
        ],
      },
    } as const;

    expect(libraryQueryPageSchema.parse(page)).toEqual(page);
    expect(
      libraryQueryPageSchema.safeParse({
        ...page,
        page: { offset: 0, limit: 1 },
        items: [canonicalItem, { ...canonicalItem, id: "book-2" }],
        total: 2,
      }).success,
    ).toBe(false);
    expect(libraryQueryPageSchema.safeParse({ ...page, total: 0 }).success).toBe(false);
    expect(
      libraryQueryPageSchema.safeParse({
        ...page,
        items: [],
        total: 1,
        page: { offset: 100, limit: 1 },
      }).success,
    ).toBe(true);
    expect(
      libraryQueryPageSchema.safeParse({
        ...page,
        facets: { ...page.facets, formats: [{ value: "lit", count: 1 }] },
      }).success,
    ).toBe(false);
    expect(
      libraryQueryPageSchema.safeParse({
        ...page,
        facets: { ...page.facets, languages: [{ value: "not_a_tag", count: 1 }] },
      }).success,
    ).toBe(false);
  });

  it("keeps saved views versioned, page-independent, and JSON-safe", async () => {
    const request = {
      id: "view-1",
      name: "Classics",
      definition: {
        version: 1,
        query: "",
        filters: {
          authors: [],
          tags: ["Classic"],
          series: ["Hainish Cycle"],
          languages: ["en"],
          formats: ["epub"],
        },
        sort: { field: "series", direction: "ascending" },
      },
    } as const;
    const saved = {
      ...request,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    } as const;
    const viewStore: SavedLibraryViewStore = {
      listSavedViews: async () => ({ ok: true, value: [saved] }),
      saveSavedView: async () => ({ ok: true, value: saved }),
      removeSavedView: async () => ({ ok: true, value: saved }),
    };

    expect(saveSavedLibraryViewRequestSchema.parse(request)).toEqual(request);
    expect(savedLibraryViewSchema.parse(saved)).toEqual(saved);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    await expect(viewStore.listSavedViews({})).resolves.toEqual({ ok: true, value: [saved] });
    await expect(viewStore.saveSavedView(request)).resolves.toEqual({ ok: true, value: saved });
    await expect(viewStore.removeSavedView({ id: request.id })).resolves.toEqual({
      ok: true,
      value: saved,
    });

    expect(
      saveSavedLibraryViewRequestSchema.safeParse({
        ...request,
        definition: { ...request.definition, page: { offset: 0, limit: 100 } },
      }).success,
    ).toBe(false);
    expect(removeSavedLibraryViewRequestSchema.safeParse({ id: "" }).success).toBe(false);
    expect(savedLibraryViewSchema.safeParse({ ...saved, definition: { ...saved.definition, version: 2 } }).success).toBe(false);
  });

  it("bounds saved-view names after trimming", () => {
    const name = "v".repeat(MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH);
    const request = {
      id: "view-1",
      name,
      definition: {
        version: 1,
        query: "",
        filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
        sort: { field: "title", direction: "ascending" },
      },
    } as const;
    const saved = {
      ...request,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:00.000Z",
    } as const;

    expect(saveSavedLibraryViewRequestSchema.parse({ ...request, name: ` ${name} ` }).name).toBe(
      name,
    );
    expect(savedLibraryViewSchema.safeParse(saved).success).toBe(true);

    const overLimitName = `${name}v`;
    expect(
      saveSavedLibraryViewRequestSchema.safeParse({ ...request, name: overLimitName }).success,
    ).toBe(false);
    expect(savedLibraryViewSchema.safeParse({ ...saved, name: overLimitName }).success).toBe(false);
    expect(saveSavedLibraryViewRequestSchema.safeParse({ ...request, name: "   " }).success).toBe(
      false,
    );
    expect(savedLibraryViewSchema.safeParse({ ...saved, name: "   " }).success).toBe(false);
  });

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

  it("validates rich metadata edits and complete tag replacement", () => {
    const patch: LibraryMetadataPatch = {
      title: "Kindred",
      author: "Octavia E. Butler",
      authors: [
        { name: "Octavia E. Butler", sortName: "Butler, Octavia E." },
        { name: "Contributor" },
      ],
      series: "Patternist",
      seriesIndex: 4.5,
      publisher: "Doubleday",
      languages: ["en-US", "fr"],
      identifiers: { isbn: "978-0-385-15059-0" },
      publishedDate: "1979-06",
      rating: 8.5,
      description: "A novel",
      tags: ["Classic"],
    };
    const clears: LibraryMetadataPatch = {
      author: null,
      authors: null,
      series: null,
      seriesIndex: null,
      publisher: null,
      languages: null,
      identifiers: null,
      publishedDate: null,
      rating: null,
      description: null,
      tags: [],
    };

    if (false) {
      // @ts-expect-error Source identity is immutable through metadata updates.
      const invalid: LibraryMetadataPatch = { tags: [], sourcePath: "elsewhere.epub" };
      expect(invalid).toBeUndefined();
    }
    expect(libraryMetadataPatchSchema.parse(patch)).toEqual(patch);
    expect(libraryMetadataPatchSchema.parse(clears)).toEqual(clears);
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);

    for (const invalid of [
      { tags: [], sourcePath: "elsewhere.epub" },
      { tags: [], title: " " },
      { tags: [], authors: [] },
      { tags: [], authors: [{ name: " " }] },
      { tags: [], seriesIndex: Number.POSITIVE_INFINITY },
      { tags: [], languages: [] },
      { tags: [], languages: ["English (US)"] },
      { tags: [], identifiers: { isbn: " " } },
      { tags: [], publishedDate: "1979-13" },
      { tags: [], rating: 10.1 },
      { tags: ["Classic", " classic "] },
      { title: "Kindred" },
    ]) {
      expect(libraryMetadataPatchSchema.safeParse(invalid).success).toBe(false);
    }
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
      "format-changed",
      "not-trashed",
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
    const replaced: LibraryReplaceFormatWireResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: true },
    };
    const trashed: LibraryTrashWireResult = {
      ok: true,
      value: { item: canonicalItem },
    };
    const restored: LibraryRestoreWireResult = {
      ok: true,
      value: { item: canonicalItem },
    };
    const purged: LibraryPurgeWireResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: true },
    };
    const trashList: LibraryTrashListWireResult = {
      ok: true,
      value: {
        items: [canonicalItem],
        total: 1,
        page: { offset: 0, limit: 25 },
      },
    };

    expect(
      JSON.parse(
        JSON.stringify({ listed, imported, removed, replaced, trashList, trashed, restored, purged }),
      ),
    ).toEqual({
      listed,
      imported,
      removed,
      replaced,
      trashList,
      trashed,
      restored,
      purged,
    });
  });

  it("defines retry-safe trash, restore, and purge boundaries", async () => {
    const request = { id: canonicalItem.id } as const;
    const listRequest = { page: { offset: 0, limit: 25 } } as const;
    const listResult: ListLibraryTrashResult = {
      ok: true,
      value: { items: [canonicalItem], total: 1, page: listRequest.page },
    };
    const trashResult: TrashLibraryItemResult = { ok: true, value: canonicalItem };
    const restoreResult: RestoreLibraryItemResult = { ok: true, value: canonicalItem };
    const purgeResult: PurgeLibraryItemResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: true },
    };
    const trashStore: LibraryItemTrashStore = {
      listTrash: async () => listResult,
      trash: async () => trashResult,
      restore: async () => restoreResult,
      purge: async () => purgeResult,
    };

    expect(listLibraryTrashRequestSchema.parse(listRequest)).toEqual(listRequest);
    expect(libraryTrashPageSchema.parse(listResult.value)).toEqual(listResult.value);
    expect(trashLibraryItemRequestSchema.parse(request)).toEqual(request);
    expect(restoreLibraryItemRequestSchema.parse(request)).toEqual(request);
    expect(purgeLibraryItemRequestSchema.parse(request)).toEqual(request);
    await expect(trashStore.listTrash(listRequest)).resolves.toEqual(listResult);
    await expect(trashStore.trash(request)).resolves.toEqual(trashResult);
    await expect(trashStore.trash(request)).resolves.toEqual(trashResult);
    await expect(trashStore.restore(request)).resolves.toEqual(restoreResult);
    await expect(trashStore.restore(request)).resolves.toEqual(restoreResult);
    await expect(trashStore.purge(request)).resolves.toEqual(purgeResult);

    for (const invalid of [{ id: "" }, { id: canonicalItem.id, force: true }, {}, null]) {
      expect(trashLibraryItemRequestSchema.safeParse(invalid).success).toBe(false);
      expect(restoreLibraryItemRequestSchema.safeParse(invalid).success).toBe(false);
      expect(purgeLibraryItemRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      listLibraryTrashRequestSchema.safeParse({
        page: { offset: 0, limit: MAX_LIBRARY_QUERY_PAGE_SIZE + 1 },
      }).success,
    ).toBe(false);
    expect(
      listLibraryTrashRequestSchema.safeParse({ ...listRequest, includeActive: true }).success,
    ).toBe(false);
    expect(
      libraryTrashPageSchema.safeParse({
        ...listResult.value,
        items: [canonicalItem, { ...canonicalItem, id: "book-2" }],
        total: 2,
        page: { offset: 0, limit: 1 },
      }).success,
    ).toBe(false);
    expect(libraryTrashPageSchema.safeParse({ ...listResult.value, total: 0 }).success).toBe(false);

    const missingTrash: TrashLibraryItemResult = { ok: true, value: null };
    const missingRestore: RestoreLibraryItemResult = { ok: true, value: null };
    const repeatedPurge: PurgeLibraryItemResult = {
      ok: true,
      value: { item: null, cleanupPending: false },
    };
    const activePurge: PurgeLibraryItemResult = {
      ok: false,
      error: { code: "not-trashed" },
    };
    const retryResults = {
      trashResult,
      restoreResult,
      purgeResult,
      listResult,
      missingTrash,
      missingRestore,
      repeatedPurge,
    };
    expect(JSON.parse(JSON.stringify(retryResults))).toEqual(retryResults);
    expect(activePurge).toEqual({ ok: false, error: { code: "not-trashed" } });
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
      source: {
        kind: "copy",
        path: "/external/left-hand.pdf",
        expectedArtifact: { bytes: 42, sha256: "a".repeat(64) },
      },
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
      const invalidReferenceIntegrity: AttachLibraryFormatRequest = {
        id: canonicalItem.id,
        // @ts-expect-error Integrity-gated publication applies only to managed copies.
        source: {
          kind: "reference",
          path: "/external/left-hand.pdf",
          expectedArtifact: { bytes: 42, sha256: "a".repeat(64) },
        },
      };
      expect([invalidImport, invalidAttach, invalidReferenceIntegrity]).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify({ imported, attached, removed }))).toEqual({
      imported,
      attached,
      removed,
    });
  });

  it("requires a strict compare-and-swap snapshot for format replacement", () => {
    const expectedCurrent = {
      sourcePath: "library/left-hand.epub",
      addedAt: "2026-07-17T12:00:00.000Z",
      provenance: "managed",
    } as const;
    const managed: ReplaceLibraryFormatRequest = {
      id: canonicalItem.id,
      format: "epub",
      expectedCurrent,
      source: {
        kind: "copy",
        path: "/external/replacement.epub",
        expectedArtifact: { bytes: 42, sha256: "a".repeat(64) },
      },
    };
    const referenced: ReplaceLibraryFormatRequest = {
      id: canonicalItem.id,
      format: "pdf",
      expectedCurrent: {
        sourcePath: "library/left-hand.pdf",
        addedAt: "2026-07-19T12:00:00.000Z",
        provenance: "referenced",
      },
      source: { kind: "reference", path: "/external/replacement.pdf" },
    };
    const result: ReplaceLibraryFormatResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: false },
    };
    const replacementStore: LibraryFormatReplacementStore = {
      replaceFormat: async () => result,
    };

    expect(replaceLibraryFormatRequestSchema.parse(managed)).toEqual(managed);
    expect(replaceLibraryFormatRequestSchema.parse(referenced)).toEqual(referenced);
    expect(replacementStore.replaceFormat(managed)).resolves.toEqual(result);
    expect(JSON.parse(JSON.stringify({ managed, referenced, result }))).toEqual({
      managed,
      referenced,
      result,
    });

    const invalidRequests = [
      { format: "epub", expectedCurrent, source: managed.source },
      { ...managed, id: "" },
      { ...managed, format: "lit" },
      { ...managed, expectedCurrent: undefined },
      { ...managed, expectedCurrent: { ...expectedCurrent, sourcePath: "" } },
      { ...managed, expectedCurrent: { ...expectedCurrent, addedAt: "yesterday" } },
      { ...managed, expectedCurrent: { ...expectedCurrent, provenance: "owned" } },
      { ...managed, expectedCurrent: { ...expectedCurrent, format: "epub" } },
      { ...managed, source: { kind: "copy", path: "" } },
      { ...managed, source: { kind: "reference", path: "" } },
      {
        ...managed,
        source: {
          kind: "reference",
          path: "/external/replacement.epub",
          expectedArtifact: { bytes: 42, sha256: "a".repeat(64) },
        },
      },
      {
        ...managed,
        source: {
          kind: "copy",
          path: "/external/replacement.epub",
          expectedArtifact: { bytes: 0, sha256: "a".repeat(64) },
        },
      },
      {
        ...managed,
        source: {
          kind: "copy",
          path: "/external/replacement.epub",
          expectedArtifact: { bytes: 42, sha256: "A".repeat(64) },
        },
      },
      { ...managed, unexpected: true },
    ];
    for (const request of invalidRequests) {
      expect(replaceLibraryFormatRequestSchema.safeParse(request).success).toBe(false);
    }

    if (false) {
      // @ts-expect-error The current format snapshot is required for compare-and-swap replacement.
      const missingSnapshot: ReplaceLibraryFormatRequest = {
        id: canonicalItem.id,
        format: "epub",
        source: { kind: "reference", path: "/external/replacement.epub" },
      };
      const invalidReferenceIntegrity: ReplaceLibraryFormatRequest = {
        ...referenced,
        // @ts-expect-error Integrity-gated publication applies only to managed copies.
        source: {
          kind: "reference",
          path: "/external/replacement.pdf",
          expectedArtifact: { bytes: 42, sha256: "a".repeat(64) },
        },
      };
      expect([missingSnapshot, invalidReferenceIntegrity]).toBeUndefined();
    }
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
    const purge: PurgeLibraryItemResult = {
      ok: true,
      value: { item: canonicalItem, cleanupPending: true },
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
      // @ts-expect-error Cleanup status cannot be omitted from permanent purge.
      const incompletePurge: PurgeLibraryItemResult = {
        ok: true,
        value: { item: canonicalItem },
      };
      expect([incompleteItemRemoval, incompleteFormatRemoval, incompletePurge]).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify({ itemRemoval, formatRemoval, purge }))).toEqual({
      itemRemoval,
      formatRemoval,
      purge,
    });
  });
});
