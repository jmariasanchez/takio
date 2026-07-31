import { describe, expect, it } from "bun:test";

import {
  LIBRARY_QUERY_SORT_DIRECTIONS,
  LIBRARY_QUERY_SORT_FIELDS,
  LIBRARY_STORE_ERROR_CODES,
  DUPLICATE_REVIEW_DISPOSITIONS,
  LIBRARY_IMPORT_DUPLICATE_REASONS,
  LIBRARY_IMPORT_FAILURE_CODES,
  LIBRARY_IMPORT_SKIPPED_REASONS,
  LIBRARY_EXPORT_FAILURE_CODES,
  LIBRARY_EXPORT_METADATA_STATES,
  LIBRARY_EXPORT_SKIPPED_REASONS,
  MAX_LIBRARY_QUERY_PAGE_SIZE,
  MAX_LIBRARY_IMPORT_ROOTS,
  MAX_LIBRARY_EXPORT_ITEMS,
  MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH,
  type AddLibraryItemRequest,
  type AttachLibraryFormatRequest,
  type ImportLibraryItemRequest,
  type ImportLibraryItemsRequest,
  type ExportLibraryItemsRequest,
  type KeepDuplicatePairResult,
  type LibraryDuplicateReviewStore,
  type LibraryImportWireResult,
  type LibraryBatchImportStore,
  type LibraryBatchImportWireResult,
  type LibraryExportStore,
  type LibraryExportWireResult,
  type LibraryListWireResult,
  type LibraryFormatReplacementStore,
  type LibraryItemTrashStore,
  type LibraryMetadataPatch,
  type ListDuplicateCandidatesRequest,
  type ListDuplicateCandidatesResult,
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
  type MergeDuplicatePairRequest,
  type MergeDuplicatePairResult,
  type ReopenDuplicatePairResult,
  type TrashLibraryItemResult,
  libraryMetadataPatchSchema,
  importLibraryItemsRequestSchema,
  exportLibraryItemsRequestSchema,
  libraryExportEntryOutcomeSchema,
  libraryExportReportSchema,
  libraryImportEntryOutcomeSchema,
  libraryImportReportSchema,
  duplicateCandidatePageSchema,
  duplicateCandidateSchema,
  duplicateSignalSchema,
  keepDuplicatePairRequestSchema,
  libraryQueryPageSchema,
  libraryTrashPageSchema,
  listLibraryTrashRequestSchema,
  listDuplicateCandidatesRequestSchema,
  mergeDuplicatePairRequestSchema,
  purgeLibraryItemRequestSchema,
  queryLibraryItemsRequestSchema,
  replaceLibraryFormatRequestSchema,
  removeSavedLibraryViewRequestSchema,
  restoreLibraryItemRequestSchema,
  reopenDuplicatePairRequestSchema,
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

const duplicateItem = {
  ...canonicalItem,
  id: "book-2",
  sourcePath: "library/left-hand-copy.epub",
  formats: [
    {
      ...canonicalItem.formats[0],
      sourcePath: "library/left-hand-copy.epub",
    },
    canonicalItem.formats[1],
  ],
} as const;

const duplicateReviewToken = "a".repeat(64);

describe("LibraryStore", () => {
  it("defines strict recursive import requests and exactly accounted outcomes", async () => {
    const request: ImportLibraryItemsRequest = {
      roots: ["/external/books", "/external/standalone.epub"],
    };
    const outcomes = [
      {
        status: "imported",
        sourcePath: "/external/books/left-hand.epub",
        item: canonicalItem,
      },
      {
        status: "skipped",
        sourcePath: "/external/books/cover.jpg",
        reason: "unsupported-format",
      },
      {
        status: "skipped",
        sourcePath: "/external/books/linked",
        reason: "symbolic-link",
      },
      {
        status: "skipped",
        sourcePath: "/external/books/pipe",
        reason: "unsupported-file-type",
      },
      {
        status: "duplicate",
        sourcePath: "/external/standalone.epub",
        existing: { itemId: canonicalItem.id, format: "epub" },
        reason: "existing-library",
      },
      {
        status: "duplicate",
        sourcePath: "/external/books/copy.epub",
        existing: { itemId: canonicalItem.id, format: "epub" },
        reason: "earlier-in-request",
      },
      {
        status: "failed",
        sourcePath: "/external/books/missing.pdf",
        code: "not-found",
      },
    ] as const;
    const result: LibraryBatchImportWireResult = {
      ok: true,
      value: {
        outcomes,
        counts: { total: 7, imported: 1, skipped: 3, duplicates: 2, failed: 1 },
      },
    };
    const store: LibraryBatchImportStore = {
      importMany: async () => result,
    };

    expect(MAX_LIBRARY_IMPORT_ROOTS).toBe(256);
    expect(LIBRARY_IMPORT_SKIPPED_REASONS).toEqual([
      "unsupported-format",
      "symbolic-link",
      "unsupported-file-type",
    ]);
    expect(LIBRARY_IMPORT_DUPLICATE_REASONS).toEqual([
      "existing-library",
      "earlier-in-request",
    ]);
    expect(LIBRARY_IMPORT_FAILURE_CODES).toEqual([
      "not-found",
      "unreadable",
      "source-changed",
      "storage-unavailable",
      "invalid-title",
    ]);
    expect(importLibraryItemsRequestSchema.parse(request)).toEqual(request);
    expect(outcomes.map((outcome) => libraryImportEntryOutcomeSchema.parse(outcome))).toEqual(
      outcomes,
    );
    expect(libraryImportReportSchema.parse(result.value)).toEqual(result.value);
    await expect(store.importMany(request)).resolves.toEqual(result);
    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({ request, result });

    for (const invalid of [
      {},
      { roots: [] },
      { roots: ["   "] },
      { roots: ["/external/books"], recursive: true },
      { roots: Array.from({ length: MAX_LIBRARY_IMPORT_ROOTS + 1 }, (_, index) => `/book-${index}`) },
    ]) {
      expect(importLibraryItemsRequestSchema.safeParse(invalid).success).toBe(false);
    }

    for (const count of ["total", "imported", "skipped", "duplicates", "failed"] as const) {
      expect(
        libraryImportReportSchema.safeParse({
          ...result.value,
          counts: { ...result.value.counts, [count]: result.value.counts[count] + 1 },
        }).success,
      ).toBe(false);
    }

    for (const invalid of [
      { ...outcomes[0], unexpected: true },
      { ...outcomes[1], reason: "hidden-file" },
      { ...outcomes[4], reason: "same-title" },
      { ...outcomes[6], code: "permission-denied" },
      { ...outcomes[6], status: "error" },
    ]) {
      expect(libraryImportEntryOutcomeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("defines strict bulk export requests and exactly accounted per-format outcomes", async () => {
    const request: ExportLibraryItemsRequest = {
      ids: [canonicalItem.id, duplicateItem.id, "missing-book"],
      destinationPath: "/external/export",
    };
    const outcomes = [
      {
        status: "exported",
        itemId: canonicalItem.id,
        format: "epub",
        provenance: "managed",
        destinationPath: "/external/export/The Left Hand of Darkness.epub",
        bytes: 1024,
        sha256: "a".repeat(64),
      },
      {
        status: "skipped",
        itemId: canonicalItem.id,
        format: "pdf",
        provenance: "referenced",
        destinationPath: "/external/export/The Left Hand of Darkness.pdf",
        reason: "destination-exists",
      },
      {
        status: "failed",
        itemId: "missing-book",
        code: "item-not-found",
      },
      {
        status: "failed",
        itemId: duplicateItem.id,
        format: "epub",
        provenance: "managed",
        destinationPath: "/external/export/Copy.epub",
        code: "source-unavailable",
      },
      {
        status: "failed",
        itemId: duplicateItem.id,
        format: "pdf",
        provenance: "referenced",
        destinationPath: "/external/export/Copy.pdf",
        code: "source-changed",
      },
      {
        status: "failed",
        itemId: duplicateItem.id,
        format: "mobi",
        provenance: "managed",
        destinationPath: "/external/export/Copy.mobi",
        code: "destination-unavailable",
      },
    ] as const;
    const result: LibraryExportWireResult = {
      ok: true,
      value: {
        outcomes,
        counts: { total: 6, exported: 1, skipped: 1, failed: 4 },
      },
    };
    const store: LibraryExportStore = {
      exportMany: async () => result,
    };

    expect(MAX_LIBRARY_EXPORT_ITEMS).toBe(256);
    expect(LIBRARY_EXPORT_SKIPPED_REASONS).toEqual(["destination-exists"]);
    expect(LIBRARY_EXPORT_FAILURE_CODES).toEqual([
      "item-not-found",
      "source-unavailable",
      "source-changed",
      "destination-unavailable",
      "metadata-write-failed",
    ]);
    expect(LIBRARY_EXPORT_METADATA_STATES).toEqual([
      "embedded",
      "unsupported",
      "backend-unavailable",
    ]);
    expect(exportLibraryItemsRequestSchema.parse(request)).toEqual(request);
    expect(outcomes.map((outcome) => libraryExportEntryOutcomeSchema.parse(outcome))).toEqual(
      outcomes,
    );
    expect(libraryExportReportSchema.parse(result.value)).toEqual(result.value);
    await expect(store.exportMany(request)).resolves.toEqual(result);
    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({ request, result });

    for (const invalid of [
      {},
      { ids: [], destinationPath: request.destinationPath },
      { ids: ["   "], destinationPath: request.destinationPath },
      { ids: [canonicalItem.id, canonicalItem.id], destinationPath: request.destinationPath },
      {
        ids: Array.from({ length: MAX_LIBRARY_EXPORT_ITEMS + 1 }, (_, index) => `book-${index}`),
        destinationPath: request.destinationPath,
      },
      { ids: [canonicalItem.id], destinationPath: "   " },
      { ...request, overwrite: true },
    ]) {
      expect(exportLibraryItemsRequestSchema.safeParse(invalid).success).toBe(false);
    }

    for (const count of ["total", "exported", "skipped", "failed"] as const) {
      expect(
        libraryExportReportSchema.safeParse({
          ...result.value,
          counts: { ...result.value.counts, [count]: result.value.counts[count] + 1 },
        }).success,
      ).toBe(false);
    }

    for (const invalid of [
      { ...outcomes[0], bytes: 0 },
      { ...outcomes[0], sha256: "A".repeat(64) },
      { ...outcomes[0], unexpected: true },
      { ...outcomes[1], reason: "overwritten" },
      { ...outcomes[2], destinationPath: request.destinationPath },
      { ...outcomes[3], code: "item-not-found" },
      { ...outcomes[3], provenance: "external" },
      { ...outcomes[3], format: "exe" },
      { ...outcomes[3], code: "permission-denied" },
    ]) {
      expect(libraryExportEntryOutcomeSchema.safeParse(invalid).success).toBe(false);
    }
  });

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

  it("defines deterministic, bounded duplicate candidate pages", async () => {
    const signals = [
      {
        kind: "same-content",
        leftFormat: "epub",
        rightFormat: "epub",
        bytes: 42,
        sha256: "b".repeat(64),
      },
      { kind: "same-identifier", scheme: "isbn", value: "9780385150590" },
      {
        kind: "same-title-author",
        title: "the left hand of darkness",
        author: "ursula k. le guin",
      },
    ] as const;
    const candidate = {
      left: canonicalItem,
      right: duplicateItem,
      signals,
      reviewToken: duplicateReviewToken,
    } as const;
    const request: ListDuplicateCandidatesRequest = {
      page: { offset: 0, limit: 25 },
      disposition: "unreviewed",
    };
    const result: ListDuplicateCandidatesResult = {
      ok: true,
      value: {
        candidates: [candidate],
        total: 1,
        page: request.page,
        scan: { filesHashed: 2, fingerprintsReused: 0, unreadableFormats: 1 },
      },
    };
    const store: LibraryDuplicateReviewStore = {
      listDuplicateCandidates: async () => result,
      keepDuplicatePair: async () => ({ ok: true, value: null }),
      reopenDuplicatePair: async () => ({ ok: true, value: null }),
      mergeDuplicatePair: async () => ({
        ok: true,
        value: {
          target: canonicalItem,
          trashedSource: duplicateItem,
          cleanupPending: false,
        },
      }),
    };

    expect(DUPLICATE_REVIEW_DISPOSITIONS).toEqual(["unreviewed", "kept-both"]);
    expect(signals.map((signal) => duplicateSignalSchema.parse(signal))).toEqual(signals);
    expect(duplicateCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(listDuplicateCandidatesRequestSchema.parse(request)).toEqual(request);
    expect(duplicateCandidatePageSchema.parse(result.value)).toEqual(result.value);
    await expect(store.listDuplicateCandidates(request)).resolves.toEqual(result);
    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({
      request,
      result,
    });

    for (const invalid of [
      { ...signals[0], bytes: 0 },
      { ...signals[0], sha256: "B".repeat(64) },
      { ...signals[0], digest: signals[0].sha256 },
      { kind: "same-identifier", scheme: "isbn", value: " " },
      { kind: "same-title-author", title: " ", author: "writer" },
      { kind: "similar-title", title: "the left hand of darkness" },
    ]) {
      expect(duplicateSignalSchema.safeParse(invalid).success).toBe(false);
    }
    expect(duplicateCandidateSchema.safeParse({ ...candidate, signals: [] }).success).toBe(false);
    expect(
      duplicateCandidateSchema.safeParse({
        ...candidate,
        left: duplicateItem,
        right: canonicalItem,
      }).success,
    ).toBe(false);
    expect(
      listDuplicateCandidatesRequestSchema.safeParse({
        ...request,
        page: { offset: 0, limit: MAX_LIBRARY_QUERY_PAGE_SIZE + 1 },
      }).success,
    ).toBe(false);
    expect(
      listDuplicateCandidatesRequestSchema.safeParse({
        ...request,
        disposition: "merged",
      }).success,
    ).toBe(false);
    expect(
      listDuplicateCandidatesRequestSchema.safeParse({
        ...request,
        includeTrashed: true,
      }).success,
    ).toBe(false);
    expect(
      duplicateCandidatePageSchema.safeParse({
        ...result.value,
        candidates: [candidate, candidate],
        total: 2,
        page: { offset: 0, limit: 1 },
      }).success,
    ).toBe(false);
    expect(duplicateCandidatePageSchema.safeParse({ ...result.value, total: 0 }).success).toBe(
      false,
    );
    expect(
      duplicateCandidatePageSchema.safeParse({
        ...result.value,
        scan: { ...result.value.scan, unreadableFormats: -1 },
      }).success,
    ).toBe(false);
  });

  it("requires current canonical evidence for duplicate dispositions", async () => {
    const request = {
      leftId: canonicalItem.id,
      rightId: duplicateItem.id,
      reviewToken: duplicateReviewToken,
    } as const;
    const kept: KeepDuplicatePairResult = { ok: true, value: null };
    const reopened: ReopenDuplicatePairResult = { ok: true, value: null };
    const store: LibraryDuplicateReviewStore = {
      listDuplicateCandidates: async ({ page }) => ({
        ok: true,
        value: {
          candidates: [],
          total: 0,
          page,
          scan: { filesHashed: 0, fingerprintsReused: 0, unreadableFormats: 0 },
        },
      }),
      keepDuplicatePair: async () => kept,
      reopenDuplicatePair: async () => reopened,
      mergeDuplicatePair: async () => ({
        ok: true,
        value: {
          target: canonicalItem,
          trashedSource: duplicateItem,
          cleanupPending: false,
        },
      }),
    };

    expect(keepDuplicatePairRequestSchema.parse(request)).toEqual(request);
    expect(reopenDuplicatePairRequestSchema.parse(request)).toEqual(request);
    await expect(store.keepDuplicatePair(request)).resolves.toEqual(kept);
    await expect(store.reopenDuplicatePair(request)).resolves.toEqual(reopened);

    for (const invalid of [
      { ...request, leftId: "" },
      { ...request, rightId: request.leftId },
      { ...request, leftId: request.rightId, rightId: request.leftId },
      { ...request, reviewToken: "not-a-token" },
      { ...request, reviewToken: "A".repeat(64) },
      { ...request, force: true },
    ]) {
      expect(keepDuplicatePairRequestSchema.safeParse(invalid).success).toBe(false);
      expect(reopenDuplicatePairRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("defines an explicit merge-to-trash request and result", async () => {
    const request: MergeDuplicatePairRequest = {
      targetId: canonicalItem.id,
      sourceId: duplicateItem.id,
      reviewToken: duplicateReviewToken,
      metadata: { title: canonicalItem.title, tags: ["Classic"] },
      addSourceFormats: ["pdf"],
      cover: "target",
    };
    const result: MergeDuplicatePairResult = {
      ok: true,
      value: {
        target: canonicalItem,
        trashedSource: duplicateItem,
        cleanupPending: false,
      },
    };
    const store: LibraryDuplicateReviewStore = {
      listDuplicateCandidates: async ({ page }) => ({
        ok: true,
        value: {
          candidates: [],
          total: 0,
          page,
          scan: { filesHashed: 0, fingerprintsReused: 0, unreadableFormats: 0 },
        },
      }),
      keepDuplicatePair: async () => ({ ok: true, value: null }),
      reopenDuplicatePair: async () => ({ ok: true, value: null }),
      mergeDuplicatePair: async () => result,
    };

    expect(mergeDuplicatePairRequestSchema.parse(request)).toEqual(request);
    expect(
      mergeDuplicatePairRequestSchema.parse({
        ...request,
        metadata: { title: canonicalItem.title },
      }),
    ).toEqual({ ...request, metadata: { title: canonicalItem.title } });
    await expect(store.mergeDuplicatePair(request)).resolves.toEqual(result);
    expect(JSON.parse(JSON.stringify({ request, result }))).toEqual({
      request,
      result,
    });

    for (const invalid of [
      { ...request, targetId: "" },
      { ...request, sourceId: request.targetId },
      { ...request, reviewToken: "stale" },
      { ...request, metadata: {} },
      { ...request, metadata: { tags: [], sourcePath: "/external/book.epub" } },
      { ...request, addSourceFormats: ["pdf", "pdf"] },
      { ...request, addSourceFormats: ["lit"] },
      { ...request, cover: "newest" },
      { ...request, purgeSource: true },
    ]) {
      expect(mergeDuplicatePairRequestSchema.safeParse(invalid).success).toBe(false);
    }
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
      customMetadata: { acquisition_source: "Library sale" },
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
      customMetadata: null,
      publishedDate: null,
      rating: null,
      description: null,
      tags: [],
    };
    const sharedFieldOnly: LibraryMetadataPatch = {
      series: "Patternist",
      publisher: "Doubleday",
    };

    if (false) {
      // @ts-expect-error Source identity is immutable through metadata updates.
      const invalid: LibraryMetadataPatch = { tags: [], sourcePath: "elsewhere.epub" };
      expect(invalid).toBeUndefined();
    }
    expect(libraryMetadataPatchSchema.parse(patch)).toEqual(patch);
    expect(libraryMetadataPatchSchema.parse(clears)).toEqual(clears);
    expect(libraryMetadataPatchSchema.parse(sharedFieldOnly)).toEqual(sharedFieldOnly);
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);

    for (const invalid of [
      {},
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
      "stale-review",
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
