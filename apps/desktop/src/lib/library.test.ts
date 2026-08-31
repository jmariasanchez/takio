import { expect, test } from "bun:test";
import type {
  ExportLibraryItemsRequest,
  KeepDuplicatePairRequest,
  ListDuplicateCandidatesRequest,
  ListLibraryTrashRequest,
  LibraryMetadataPatch,
  MergeDuplicatePairRequest,
  QueryLibraryItemsRequest,
  SaveSavedLibraryViewRequest,
} from "@takio/library-contract";

import {
  attachLibraryFormat,
  describeLibraryError,
  describeUnexpectedLibraryError,
  exportLibraryItems,
  getLibraryItem,
  importLibraryItem,
  importLibraryItems,
  keepDuplicatePair,
  listDuplicateCandidates,
  listLibraryItems,
  listLibraryTrash,
  listSavedLibraryViews,
  mergeDuplicatePair,
  openLibraryItem,
  parseLibraryTags,
  purgeLibraryItem,
  queryLibraryItems,
  removeLibraryCover,
  removeLibraryFormat,
  removeSavedLibraryView,
  reopenDuplicatePair,
  restoreLibraryItem,
  saveSavedLibraryView,
  searchLibraryItems,
  setLibraryCover,
  trashLibraryItem,
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
  authors: [{ name: "An author", sortName: "Author, An" }],
  series: "A series",
  seriesIndex: 2,
  publisher: "A publisher",
  languages: ["en"],
  identifiers: { isbn: "9780000000001" },
  publishedDate: "2026-07-18",
  rating: 8,
  description: "A description",
  coverPath: "/Covers/item-1.jpg",
  tags: ["Classic"],
  updatedAt: "2026-07-19T12:00:00.000Z",
} as const;

const duplicateItem = {
  ...validItem,
  id: "item-2",
  coverPath: "/Covers/item-2.jpg",
} as const;

const duplicateReviewToken = "a".repeat(64);

const duplicateListRequest = {
  page: { offset: 0, limit: 25 },
  disposition: "unreviewed",
} as const satisfies ListDuplicateCandidatesRequest;

const duplicateReviewRequest = {
  leftId: validItem.id,
  rightId: duplicateItem.id,
  reviewToken: duplicateReviewToken,
} as const satisfies KeepDuplicatePairRequest;

const duplicateMergeRequest = {
  targetId: validItem.id,
  sourceId: duplicateItem.id,
  reviewToken: duplicateReviewToken,
  metadata: { title: validItem.title, tags: validItem.tags },
  addSourceFormats: ["pdf"],
  cover: "target",
} as const satisfies MergeDuplicatePairRequest;

const duplicateCandidatePage = {
  candidates: [
    {
      left: validItem,
      right: duplicateItem,
      signals: [
        {
          kind: "same-content",
          leftFormat: "epub",
          rightFormat: "epub",
          bytes: 42,
          sha256: "b".repeat(64),
        },
      ],
      reviewToken: duplicateReviewToken,
    },
  ],
  total: 1,
  page: duplicateListRequest.page,
  scan: { filesHashed: 2, fingerprintsReused: 0, unreadableFormats: 0 },
} as const;

const queryRequest = {
  virtualLibraryId: "classics",
  query: "title",
  filters: {
    authors: ["An author"],
    tags: ["Classic"],
    series: ["A series"],
    languages: ["en"],
    formats: ["epub"],
  },
  sort: { field: "author", direction: "ascending" },
  page: { offset: 0, limit: 25 },
} as const satisfies QueryLibraryItemsRequest;

const savedViewRequest = {
  id: "favourites",
  name: "Favourites",
  definition: {
    version: 1,
    query: queryRequest.query,
    filters: queryRequest.filters,
    sort: queryRequest.sort,
  },
} as const satisfies SaveSavedLibraryViewRequest;

const savedView = {
  ...savedViewRequest,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:30:00.000Z",
} as const;

const queryPage = {
  items: [validItem],
  total: 1,
  page: queryRequest.page,
  facets: {
    authors: [{ value: "An author", count: 1 }],
    tags: [{ value: "Classic", count: 1 }],
    series: [{ value: "A series", count: 1 }],
    languages: [{ value: "en", count: 1 }],
    formats: [
      { value: "epub", count: 1 },
      { value: "pdf", count: 1 },
    ],
  },
} as const;

const trashRequest = {
  page: { offset: 0, limit: 25 },
} as const satisfies ListLibraryTrashRequest;

const trashPage = {
  items: [validItem],
  total: 1,
  page: trashRequest.page,
} as const;

const metadataPatch = {
  title: "A new title",
  author: null,
  authors: [{ name: "Another author", sortName: "Author, Another" }],
  series: "Another series",
  seriesIndex: 3,
  publisher: "Another publisher",
  languages: ["en-GB"],
  identifiers: { isbn: "9780000000002" },
  publishedDate: "2026-07-20",
  rating: 9,
  description: "A description",
  tags: ["Classic", "Science Fiction"],
} as const satisfies LibraryMetadataPatch;

const batchImportReport = {
  outcomes: [
    {
      status: "imported",
      sourcePath: validItem.sourcePath,
      item: validItem,
    },
    {
      status: "skipped",
      sourcePath: "/Books/notes.txt",
      reason: "unsupported-format",
    },
    {
      status: "duplicate",
      sourcePath: "/Books/A title.pdf",
      existing: { itemId: validItem.id, format: "pdf" },
      reason: "existing-library",
    },
    {
      status: "failed",
      sourcePath: "/Books/missing.epub",
      code: "not-found",
    },
  ],
  counts: { total: 4, imported: 1, skipped: 1, duplicates: 1, failed: 1 },
} as const;

const exportRequest = {
  ids: [validItem.id, duplicateItem.id],
  destinationPath: "/Exports",
} as const satisfies ExportLibraryItemsRequest;

const exportReport = {
  outcomes: [
    {
      status: "exported",
      itemId: validItem.id,
      format: "epub",
      provenance: "managed",
      destinationPath: "/Exports/A title.epub",
      bytes: 42,
      sha256: "c".repeat(64),
    },
    {
      status: "skipped",
      itemId: validItem.id,
      format: "pdf",
      provenance: "referenced",
      destinationPath: "/Exports/A title.pdf",
      reason: "destination-exists",
    },
    {
      status: "failed",
      itemId: duplicateItem.id,
      code: "item-not-found",
    },
  ],
  counts: { total: 3, exported: 1, skipped: 1, failed: 1 },
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
        value: { id: "item-1", format: "pdf", path: "/Books/A title.pdf" },
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
    if (command === "library_query") {
      return { ok: true, value: queryPage } as never;
    }
    if (command === "library_trash_list") {
      return { ok: true, value: trashPage } as never;
    }
    if (command === "library_purge") {
      return {
        ok: true,
        value: { item: null, cleanupPending: false },
      } as never;
    }
    if (command === "library_saved_views_list") {
      return { ok: true, value: { views: [savedView] } } as never;
    }
    if (command === "library_saved_view_save") {
      return { ok: true, value: { view: savedView } } as never;
    }
    if (command === "library_saved_view_remove") {
      return { ok: true, value: { view: null } } as never;
    }
    if (command === "library_import_many") {
      return { ok: true, value: batchImportReport } as never;
    }
    if (command === "library_export_many") {
      return { ok: true, value: exportReport } as never;
    }
    return { ok: true, value: { item: null } } as never;
  };

  await listLibraryItems(invokeCommand);
  await getLibraryItem("item-1", invokeCommand);
  await importLibraryItem("/Books/A title.epub", invokeCommand);
  await importLibraryItems(["/Books", "/Incoming/A title.epub"], "move", invokeCommand);
  await exportLibraryItems(exportRequest, invokeCommand);
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
  await updateLibraryItem("item-1", metadataPatch, invokeCommand);
  await searchLibraryItems("classic", invokeCommand);
  await queryLibraryItems(queryRequest, invokeCommand);
  await listLibraryTrash(trashRequest, invokeCommand);
  await trashLibraryItem({ id: validItem.id }, invokeCommand);
  await restoreLibraryItem({ id: validItem.id }, invokeCommand);
  await purgeLibraryItem({ id: validItem.id }, invokeCommand);
  await listSavedLibraryViews(invokeCommand);
  await saveSavedLibraryView(savedViewRequest, invokeCommand);
  await removeSavedLibraryView({ id: savedView.id }, invokeCommand);
  await setLibraryCover("item-1", "/Pictures/A cover.jpg", invokeCommand);
  await removeLibraryCover("item-1", invokeCommand);
  await openLibraryItem("item-1", "pdf", invokeCommand);

  expect(calls).toEqual([
    { command: "library_list", args: undefined },
    { command: "library_get", args: { id: "item-1" } },
    { command: "library_import", args: { sourcePath: "/Books/A title.epub" } },
    {
      command: "library_import_many",
      args: { sourcePaths: ["/Books", "/Incoming/A title.epub"], mode: "move" },
    },
    { command: "library_export_many", args: { request: exportRequest } },
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
        patch: metadataPatch,
      },
    },
    { command: "library_search", args: { query: "classic" } },
    { command: "library_query", args: { request: queryRequest } },
    { command: "library_trash_list", args: { request: trashRequest } },
    { command: "library_trash", args: { request: { id: validItem.id } } },
    { command: "library_restore", args: { request: { id: validItem.id } } },
    { command: "library_purge", args: { request: { id: validItem.id } } },
    { command: "library_saved_views_list", args: undefined },
    { command: "library_saved_view_save", args: { request: savedViewRequest } },
    {
      command: "library_saved_view_remove",
      args: { request: { id: savedView.id } },
    },
    {
      command: "library_cover_set",
      args: { id: "item-1", sourcePath: "/Pictures/A cover.jpg" },
    },
    { command: "library_cover_remove", args: { id: "item-1" } },
    { command: "library_open", args: { id: "item-1", format: "pdf" } },
  ]);

  const updateArgs = calls.find(({ command }) => command === "library_update")?.args;
  expect(updateArgs?.patch).toBe(metadataPatch);
  expect((updateArgs?.patch as LibraryMetadataPatch | undefined)?.authors).toBe(
    metadataPatch.authors,
  );
  expect((updateArgs?.patch as LibraryMetadataPatch | undefined)?.identifiers).toBe(
    metadataPatch.identifiers,
  );
});

test("uses fixed duplicate desktop commands and one request argument", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: LibraryInvoker = async (command, args) => {
    calls.push({ command, args });
    if (command === "library_duplicates_list") {
      return { ok: true, value: duplicateCandidatePage } as never;
    }
    if (command === "library_duplicates_merge") {
      return {
        ok: true,
        value: {
          target: validItem,
          trashedSource: duplicateItem,
          cleanupPending: false,
        },
      } as never;
    }
    return { ok: true, value: null } as never;
  };

  await listDuplicateCandidates(duplicateListRequest, invokeCommand);
  await keepDuplicatePair(duplicateReviewRequest, invokeCommand);
  await reopenDuplicatePair(duplicateReviewRequest, invokeCommand);
  await mergeDuplicatePair(duplicateMergeRequest, invokeCommand);

  expect(calls).toEqual([
    {
      command: "library_duplicates_list",
      args: { request: duplicateListRequest },
    },
    {
      command: "library_duplicates_keep",
      args: { request: duplicateReviewRequest },
    },
    {
      command: "library_duplicates_reopen",
      args: { request: duplicateReviewRequest },
    },
    {
      command: "library_duplicates_merge",
      args: { request: duplicateMergeRequest },
    },
  ]);
});

test("rejects invalid duplicate requests before desktop invocation", async () => {
  let invocations = 0;
  const invokeCommand: LibraryInvoker = async () => {
    invocations += 1;
    return { ok: true, value: null } as never;
  };

  expect(
    await listDuplicateCandidates(
      {
        ...duplicateListRequest,
        page: { ...duplicateListRequest.page, limit: 101 },
      } as ListDuplicateCandidatesRequest,
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(
    await keepDuplicatePair(
      { ...duplicateReviewRequest, rightId: duplicateReviewRequest.leftId },
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(
    await reopenDuplicatePair(
      { ...duplicateReviewRequest, reviewToken: "A".repeat(64) },
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(
    await mergeDuplicatePair(
      { ...duplicateMergeRequest, sourceId: duplicateMergeRequest.targetId },
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(invocations).toBe(0);
});

test("decodes duplicate candidate pages with the exact requested page", async () => {
  const result = { ok: true, value: duplicateCandidatePage } as const;
  expect(
    await listDuplicateCandidates(duplicateListRequest, async () => result as never),
  ).toBe(result);

  for (const value of [
    {
      ...duplicateCandidatePage,
      page: { ...duplicateCandidatePage.page, offset: 1 },
    },
    { ...duplicateCandidatePage, extra: true },
    { ...duplicateCandidatePage, total: 0 },
    {
      ...duplicateCandidatePage,
      candidates: [
        {
          ...duplicateCandidatePage.candidates[0],
          reviewToken: "not-a-review-token",
        },
      ],
    },
  ]) {
    expect(
      await listDuplicateCandidates(
        duplicateListRequest,
        async () => ({ ok: true, value }) as never,
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("requires exact null duplicate disposition success values", async () => {
  const success = { ok: true, value: null } as const;
  expect(
    await keepDuplicatePair(duplicateReviewRequest, async () => success as never),
  ).toBe(success);
  expect(
    await reopenDuplicatePair(duplicateReviewRequest, async () => success as never),
  ).toBe(success);

  for (const operation of [keepDuplicatePair, reopenDuplicatePair]) {
    for (const value of [{}, false, { kept: true }]) {
      expect(
        await operation(
          duplicateReviewRequest,
          async () => ({ ok: true, value }) as never,
        ),
      ).toEqual({ ok: false, error: { code: "protocol-error" } });
    }
  }
});

test("requires exact duplicate merge keys and request-matched item IDs", async () => {
  const value = {
    target: validItem,
    trashedSource: duplicateItem,
    cleanupPending: false,
  } as const;
  const result = { ok: true, value } as const;
  expect(
    await mergeDuplicatePair(duplicateMergeRequest, async () => result as never),
  ).toBe(result);

  for (const malformedValue of [
    { ...value, extra: true },
    { ...value, target: duplicateItem },
    { ...value, trashedSource: validItem },
    { ...value, cleanupPending: "no" },
    { target: validItem, cleanupPending: false },
  ]) {
    expect(
      await mergeDuplicatePair(
        duplicateMergeRequest,
        async () => ({ ok: true, value: malformedValue }) as never,
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("gets one item with strict success, missing, and domain responses", async () => {
  const foundResult = { ok: true, value: { item: validItem } } as const;
  const missingResult = { ok: true, value: { item: null } } as const;
  const domainFailure = {
    ok: false,
    error: { code: "storage-unavailable" },
  } as const;

  expect(await getLibraryItem(validItem.id, async () => foundResult as never)).toBe(
    foundResult,
  );
  expect(await getLibraryItem(validItem.id, async () => missingResult as never)).toBe(
    missingResult,
  );
  expect(await getLibraryItem(validItem.id, async () => domainFailure as never)).toBe(
    domainFailure,
  );

  for (const result of [
    { ok: true, value: {} },
    { ok: true, value: { item: validItem, extra: true } },
    { ok: true, value: { item: { ...validItem, formats: [] } } },
  ]) {
    expect(await getLibraryItem(validItem.id, async () => result as never)).toEqual({
      ok: false,
      error: { code: "protocol-error" },
    });
  }
});

test("rejects a blank library item id before desktop invocation", async () => {
  let invocationCount = 0;
  const result = await getLibraryItem(" \n", async () => {
    invocationCount += 1;
    return { ok: true, value: { item: validItem } } as never;
  });

  expect(result).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(invocationCount).toBe(0);
});

test("passes valid library responses through with authoritative format order", async () => {
  const listResult = { ok: true, value: { items: [validItem] } } as const;
  const importResult = { ok: true, value: { item: validItem } } as const;
  const updateResult = { ok: true, value: { item: validItem } } as const;
  const removeResult = {
    ok: true,
    value: { item: null, cleanupPending: true },
  } as const;
  const openResult = {
    ok: true,
    value: { id: validItem.id, format: "pdf", path: "/Books/A title.pdf" },
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
  const missingAttachResult = { ok: true, value: { item: null } } as const;
  expect(
    await attachLibraryFormat(
      validItem.id,
      "/Books/A title.mobi",
      "reference",
      async () => missingAttachResult as never,
    ),
  ).toBe(missingAttachResult);
  expect(
    await removeLibraryFormat(validItem.id, "pdf", async () => removeResult as never),
  ).toBe(removeResult);
  expect(
    await updateLibraryItem(validItem.id, metadataPatch, async () =>
      updateResult as never,
    ),
  ).toBe(updateResult);
  expect(await openLibraryItem(validItem.id, "pdf", async () => openResult as never)).toBe(
    openResult,
  );
});

test("passes an exact recursive import report through", async () => {
  const result = { ok: true, value: batchImportReport } as const;

  expect(
    await importLibraryItems(["/Books"], "copy", async () => result as never),
  ).toBe(result);
});

test("rejects malformed or inconsistently counted recursive import reports", async () => {
  const malformedReports = [
    { ...batchImportReport, unexpected: true },
    {
      ...batchImportReport,
      counts: { ...batchImportReport.counts, total: 3 },
    },
    {
      ...batchImportReport,
      counts: { ...batchImportReport.counts, imported: 1.5 },
    },
    {
      ...batchImportReport,
      outcomes: [
        { ...batchImportReport.outcomes[0], unexpected: true },
        ...batchImportReport.outcomes.slice(1),
      ],
    },
    {
      ...batchImportReport,
      outcomes: [
        batchImportReport.outcomes[0],
        { ...batchImportReport.outcomes[1], reason: "hidden-file" },
        ...batchImportReport.outcomes.slice(2),
      ],
    },
    {
      ...batchImportReport,
      outcomes: [
        ...batchImportReport.outcomes.slice(0, 2),
        {
          ...batchImportReport.outcomes[2],
          existing: { ...batchImportReport.outcomes[2].existing, format: "mp3" },
        },
        batchImportReport.outcomes[3],
      ],
    },
  ];

  for (const report of malformedReports) {
    expect(
      await importLibraryItems(["/Books"], "copy", async () => ({
        ok: true,
        value: report,
      }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("passes a strict bulk export report and domain failures through", async () => {
  const success = { ok: true, value: exportReport } as const;
  const domainFailure = {
    ok: false,
    error: { code: "storage-unavailable" },
  } as const;

  expect(
    await exportLibraryItems(exportRequest, async () => success as never),
  ).toBe(success);
  expect(
    await exportLibraryItems(exportRequest, async () => domainFailure as never),
  ).toBe(domainFailure);
});

test("forwards the selected export filename preset without changing legacy requests", async () => {
  const calls: unknown[] = [];
  const request = {
    ...exportRequest,
    fileNameTemplate: "author-title",
  } as const satisfies ExportLibraryItemsRequest;

  await exportLibraryItems(request, async (_command, args) => {
    calls.push(args);
    return { ok: true, value: exportReport } as never;
  });

  expect(calls).toEqual([{ request }]);
  expect(exportRequest).not.toHaveProperty("fileNameTemplate");
});

test("rejects invalid bulk export requests before desktop invocation", async () => {
  let invocations = 0;
  const invokeCommand: LibraryInvoker = async () => {
    invocations += 1;
    return { ok: true, value: exportReport } as never;
  };

  for (const request of [
    { ...exportRequest, ids: [] },
    { ...exportRequest, ids: [validItem.id, validItem.id] },
    { ...exportRequest, ids: [validItem.id, " \n"] },
    { ...exportRequest, destinationPath: " \n" },
    { ...exportRequest, fileNameTemplate: "series-title" },
    { ...exportRequest, overwrite: false },
  ]) {
    expect(
      await exportLibraryItems(request as ExportLibraryItemsRequest, invokeCommand),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  }

  expect(invocations).toBe(0);
});

test("rejects malformed, inconsistently counted, or request-mismatched export reports", async () => {
  const malformedReports = [
    { ...exportReport, unexpected: true },
    {
      ...exportReport,
      counts: { ...exportReport.counts, total: 2 },
    },
    {
      ...exportReport,
      counts: { ...exportReport.counts, exported: 2 },
    },
    {
      ...exportReport,
      outcomes: [
        { ...exportReport.outcomes[0], format: "mp3" },
        ...exportReport.outcomes.slice(1),
      ],
    },
    {
      ...exportReport,
      outcomes: [
        { ...exportReport.outcomes[0], bytes: 0 },
        ...exportReport.outcomes.slice(1),
      ],
    },
    {
      ...exportReport,
      outcomes: exportReport.outcomes.map((outcome) => ({
        ...outcome,
        itemId: validItem.id,
      })),
    },
    {
      ...exportReport,
      outcomes: [
        ...exportReport.outcomes.slice(0, 2),
        { ...exportReport.outcomes[2], itemId: "not-requested" },
      ],
    },
  ];

  for (const report of malformedReports) {
    expect(
      await exportLibraryItems(exportRequest, async () => ({
        ok: true,
        value: report,
      }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("passes valid query pages, facets, and saved views through", async () => {
  const queryResult = { ok: true, value: queryPage } as const;
  const listViewsResult = {
    ok: true,
    value: { views: [savedView] },
  } as const;
  const saveViewResult = { ok: true, value: { view: savedView } } as const;
  const removeViewResult = { ok: true, value: { view: null } } as const;

  expect(
    await queryLibraryItems(queryRequest, async () => queryResult as never),
  ).toBe(queryResult);
  expect(await listSavedLibraryViews(async () => listViewsResult as never)).toBe(
    listViewsResult,
  );
  expect(
    await saveSavedLibraryView(savedViewRequest, async () => saveViewResult as never),
  ).toBe(saveViewResult);
  expect(
    await removeSavedLibraryView(
      { id: savedView.id },
      async () => removeViewResult as never,
    ),
  ).toBe(removeViewResult);
});

test("passes strict trash lifecycle responses through", async () => {
  const listResult = { ok: true, value: trashPage } as const;
  const trashResult = { ok: true, value: { item: validItem } } as const;
  const restoreResult = { ok: true, value: { item: null } } as const;
  const purgeResult = {
    ok: true,
    value: { item: null, cleanupPending: true },
  } as const;
  const activePurge = { ok: false, error: { code: "not-trashed" } } as const;

  expect(
    await listLibraryTrash(trashRequest, async () => listResult as never),
  ).toBe(listResult);
  expect(
    await trashLibraryItem(
      { id: validItem.id },
      async () => trashResult as never,
    ),
  ).toBe(trashResult);
  expect(
    await restoreLibraryItem(
      { id: validItem.id },
      async () => restoreResult as never,
    ),
  ).toBe(restoreResult);
  expect(
    await purgeLibraryItem(
      { id: validItem.id },
      async () => purgeResult as never,
    ),
  ).toBe(purgeResult);
  expect(
    await purgeLibraryItem(
      { id: validItem.id },
      async () => activePurge as never,
    ),
  ).toBe(activePurge);
});

test("rejects invalid trash requests before invoking the desktop command", async () => {
  let invocations = 0;
  const invokeCommand: LibraryInvoker = async () => {
    invocations += 1;
    return { ok: true, value: { item: null } } as never;
  };

  expect(
    await listLibraryTrash(
      { page: { offset: 0, limit: 101 } } as ListLibraryTrashRequest,
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(await trashLibraryItem({ id: "" }, invokeCommand)).toEqual({
    ok: false,
    error: { code: "invalid-arguments" },
  });
  expect(
    await restoreLibraryItem(
      { id: validItem.id, extra: true } as never,
      invokeCommand,
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(await purgeLibraryItem({ id: "" }, invokeCommand)).toEqual({
    ok: false,
    error: { code: "invalid-arguments" },
  });
  expect(invocations).toBe(0);
});

test("rejects malformed or request-mismatched trash responses", async () => {
  for (const value of [
    { ...trashPage, page: { ...trashPage.page, offset: 1 } },
    { ...trashPage, extra: true },
    { ...trashPage, items: [{ ...validItem, formats: [] }] },
    { ...trashPage, total: 0 },
  ]) {
    expect(
      await listLibraryTrash(
        trashRequest,
        async () => ({ ok: true, value }) as never,
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }

  for (const operation of [trashLibraryItem, restoreLibraryItem]) {
    for (const value of [
      {},
      { item: validItem, extra: true },
      { item: { ...validItem, formats: [] } },
    ]) {
      expect(
        await operation(
          { id: validItem.id },
          async () => ({ ok: true, value }) as never,
        ),
      ).toEqual({ ok: false, error: { code: "protocol-error" } });
    }
  }

  for (const value of [
    { item: null },
    { item: null, cleanupPending: "no" },
    { item: null, cleanupPending: false, extra: true },
    { item: { ...validItem, formats: [] }, cleanupPending: false },
  ]) {
    expect(
      await purgeLibraryItem(
        { id: validItem.id },
        async () => ({ ok: true, value }) as never,
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("rejects invalid query inputs before invoking the desktop command", async () => {
  let invoked = false;
  const invalidRequest = {
    ...queryRequest,
    page: { ...queryRequest.page, limit: 101 },
  } as QueryLibraryItemsRequest;

  expect(
    await queryLibraryItems(invalidRequest, async () => {
      invoked = true;
      return { ok: true, value: queryPage } as never;
    }),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(invoked).toBe(false);
});

test("rejects malformed, over-limit, and inconsistent query responses", async () => {
  const malformedValues = [
    {
      ...queryPage,
      items: [{ ...validItem, authors: [{ name: "" }] }],
    },
    {
      ...queryPage,
      facets: {
        ...queryPage.facets,
        formats: [{ value: "lit", count: 1 }],
      },
    },
    {
      ...queryPage,
      items: Array.from({ length: queryRequest.page.limit + 1 }, (_, index) => ({
        ...validItem,
        id: `item-${index}`,
      })),
      total: queryRequest.page.limit + 1,
    },
    { ...queryPage, total: 0 },
    { ...queryPage, page: { ...queryPage.page, offset: 1 } },
  ];

  for (const value of malformedValues) {
    expect(
      await queryLibraryItems(queryRequest, async () => ({ ok: true, value }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("rejects malformed saved-view responses and invalid write requests", async () => {
  const malformedListValues = [
    { views: [{ ...savedView, definition: { ...savedView.definition, version: 2 } }] },
    { views: [{ ...savedView, updatedAt: "today" }] },
    { views: [savedView], extra: true },
  ];

  for (const value of malformedListValues) {
    expect(
      await listSavedLibraryViews(async () => ({ ok: true, value }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }

  expect(
    await saveSavedLibraryView(savedViewRequest, async () => ({
      ok: true,
      value: { view: null },
    }) as never),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });
  expect(
    await removeSavedLibraryView({ id: savedView.id }, async () => ({
      ok: true,
      value: { view: { ...savedView, name: " " } },
    }) as never),
  ).toEqual({ ok: false, error: { code: "protocol-error" } });

  let invoked = false;
  expect(
    await saveSavedLibraryView(
      { ...savedViewRequest, name: " " },
      async () => {
        invoked = true;
        return { ok: true, value: { view: savedView } } as never;
      },
    ),
  ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  expect(invoked).toBe(false);
});

test("rejects malformed or mismatched exact-format open responses", async () => {
  for (const value of [
    { id: validItem.id, format: "pdf", path: 42 },
    { id: validItem.id, path: "/Books/A title.pdf" },
    { id: validItem.id, format: "mp3", path: "/Books/A title.mp3" },
    { id: validItem.id, format: "epub", path: "/Books/A title.epub" },
    { id: "another-item", format: "pdf", path: "/Books/A title.pdf" },
  ]) {
    expect(
      await openLibraryItem(validItem.id, "pdf", async () => ({
        ok: true,
        value,
      }) as never),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  }
});

test("rejects malformed format lifecycle success payloads", async () => {
  for (const value of [
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
  expect(describeLibraryError("format-not-found")).toBe(
    "That format is no longer available for this item.",
  );
  expect(describeLibraryError("open-failed")).toBe(
    "The source file could not be opened.",
  );
  expect(describeLibraryError("stale-review")).toBe(
    "This duplicate pair changed. Close and reopen duplicate review before deciding.",
  );
});

test("does not expose unexpected implementation details in user-facing errors", () => {
  const implementationDetail = "Cannot read properties of undefined (reading 'invoke')";
  const message = describeUnexpectedLibraryError(new Error(implementationDetail));

  expect(message).toBe("The local library is unavailable.");
  expect(message).not.toContain(implementationDetail);
});
