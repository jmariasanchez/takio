import { expect, test } from "bun:test";
import type { BookFormat, LibraryItem } from "@takio/core";
import type {
  LibraryFacetCounts,
  LibraryQueryFilters,
  LibraryQuerySort,
  SavedLibraryView,
} from "@takio/library-contract";
import { renderToStaticMarkup } from "react-dom/server";

import { draftFor } from "../lib/metadata-draft";
import {
  LibraryWorkspace,
  openDuplicateReviewDialog,
  openTrashDialog,
  openSaveViewWithPaneClosed,
  restoreSaveViewDialogFocus,
  resolveGeneralSend,
  type LibraryWorkspaceProps,
} from "./LibraryWorkspace";

const epub = {
  format: "epub",
  sourcePath: "/Books/Title.epub",
  provenance: "managed",
  addedAt: "2026-07-20T12:00:00.000Z",
} as const satisfies BookFormat;

const pdf = {
  format: "pdf",
  sourcePath: "/Books/Title.pdf",
  provenance: "referenced",
  addedAt: "2026-07-20T12:01:00.000Z",
} as const satisfies BookFormat;

const item = {
  id: "item-1",
  title: "Title",
  sourcePath: epub.sourcePath,
  format: epub.format,
  formats: [epub, pdf],
  addedAt: "2026-07-20T12:00:00.000Z",
  author: "Author",
  tags: ["Classic"],
} as const satisfies LibraryItem;

const filters: LibraryQueryFilters = {
  authors: ["Author"],
  tags: [],
  series: [],
  languages: [],
  formats: [],
};

const facets: LibraryFacetCounts = {
  authors: [{ value: "Author", count: 17 }],
  tags: [{ value: "Classic", count: 8 }],
  series: [],
  languages: [],
  formats: [{ value: "epub", count: 12 }],
};

const sort = {
  field: "rating",
  direction: "descending",
} as const satisfies LibraryQuerySort;

const savedViews: readonly SavedLibraryView[] = [
  {
    id: "favourites",
    name: "Favourites",
    definition: {
      version: 1,
      query: "Dune",
      filters,
      sort,
    },
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  },
];

function props(overrides: Partial<LibraryWorkspaceProps> = {}): LibraryWorkspaceProps {
  return {
    actionsPending: false,
    conversionDraft: null,
    currentSavedViewId: "favourites",
    draft: null,
    facets,
    filters,
    items: [item],
    libraryState: "ready",
    pageLimit: 25,
    pageOffset: 25,
    pendingAction: null,
    preferredDeviceFormat: "pdf",
    query: "Dune",
    querySyntax: "literal",
    savedViews,
    saveViewDialogBusy: false,
    saveViewDialogError: null,
    saveViewDialogOpen: false,
    saveViewSuggestedName: "Dune favourites",
    searchInput: { current: null },
    searchPending: false,
    selectedDestination: {
      id: "reader",
      name: "Reader",
      path: "/Volumes/Reader",
      kind: "generic",
    },
    selectedItemId: item.id,
    selectedItemIds: [item.id],
    sort,
    total: 42,
    onApplySavedView: () => undefined,
    onAttachFormat: async () => undefined,
    onCancelSaveView: () => undefined,
    onChangeFilters: () => undefined,
    onChangePage: () => undefined,
    onChangeSearch: () => undefined,
    onChangeSearchSyntax: () => undefined,
    onChangeSort: () => undefined,
    onChooseCover: async () => undefined,
    onClearAll: () => undefined,
    onClearCover: async () => undefined,
    onEnqueueConversion: async () => undefined,
    onOpenDuplicateReview: () => undefined,
    onOpenItem: async () => undefined,
    onOpenSaveView: () => undefined,
    onOpenTrash: () => undefined,
    onRemoveFormat: async () => undefined,
    onRemoveItem: async () => undefined,
    onRemoveSavedView: () => undefined,
    onRetry: async () => true,
    onSaveMetadata: async () => undefined,
    onSaveView: () => undefined,
    onSelectItemRange: () => undefined,
    onSelectItem: () => undefined,
    onSendItem: async () => undefined,
    onSetConversionDraft: () => undefined,
    onSetDraft: () => undefined,
    onTogglePageSelection: () => undefined,
    onToggleSelectedItem: () => undefined,
    ...overrides,
  };
}

function renderWorkspace(overrides: Partial<LibraryWorkspaceProps> = {}): string {
  return renderToStaticMarkup(<LibraryWorkspace {...props(overrides)} />);
}

test("renders an explicit structured-search mode and syntax guidance", () => {
  const markup = renderWorkspace({
    querySyntax: "structured-v1",
    query: 'author:"Ursula K. Le Guin" not tag:Modern',
  });

  expect(markup).toContain('aria-label="Search syntax"');
  expect(markup).toContain('<option value="structured-v1" selected="">Structured</option>');
  expect(markup).toContain('author:&quot;Name&quot; tag:Classic not publisher:Tor');
});

test("closes a compact pane before opening the saved-view modal so overlays cannot stack", () => {
  const calls: string[] = [];

  openSaveViewWithPaneClosed(
    (pane) => calls.push(`pane:${pane ?? "closed"}`),
    () => calls.push("dialog:open"),
  );

  expect(calls).toEqual(["pane:closed", "dialog:open"]);
});

test("opens Trash through the parent callback from a stable accessible toolbar trigger", () => {
  let openCalls = 0;

  openTrashDialog(() => {
    openCalls += 1;
  });

  expect(openCalls).toBe(1);

  const markup = renderWorkspace();
  const trigger = markup.match(/<button id="library-trash-trigger"[^>]*>/)?.[0];

  expect(trigger).toBeDefined();
  expect(trigger).toContain('aria-haspopup="dialog"');
  expect(trigger).not.toContain("disabled");
  expect(markup).toContain(`${trigger ?? ""}Trash</button>`);

  const pendingMarkup = renderWorkspace({ actionsPending: true });
  const pendingTrigger = pendingMarkup.match(/<button id="library-trash-trigger"[^>]*>/)?.[0];
  expect(pendingTrigger).toContain('disabled=""');
});

test("opens each duplicate review disposition from stable accessible toolbar triggers", () => {
  const dispositions: string[] = [];

  openDuplicateReviewDialog("unreviewed", (disposition) => {
    dispositions.push(disposition);
  });
  openDuplicateReviewDialog("kept-both", (disposition) => {
    dispositions.push(disposition);
  });

  expect(dispositions).toEqual(["unreviewed", "kept-both"]);

  const markup = renderWorkspace();
  const unreviewedTrigger = markup.match(
    /<button id="library-duplicates-trigger"[^>]*>/,
  )?.[0];
  const keptTrigger = markup.match(
    /<button id="library-kept-duplicates-trigger"[^>]*>/,
  )?.[0];

  expect(unreviewedTrigger).toBeDefined();
  expect(unreviewedTrigger).toContain('aria-haspopup="dialog"');
  expect(unreviewedTrigger).not.toContain("disabled");
  expect(markup).toContain(`${unreviewedTrigger ?? ""}Review duplicates…</button>`);
  expect(keptTrigger).toBeDefined();
  expect(keptTrigger).toContain('aria-haspopup="dialog"');
  expect(keptTrigger).not.toContain("disabled");
  expect(markup).toContain(`${keptTrigger ?? ""}Kept separate…</button>`);

  const pendingMarkup = renderWorkspace({ actionsPending: true });
  const pendingUnreviewedTrigger = pendingMarkup.match(
    /<button id="library-duplicates-trigger"[^>]*>/,
  )?.[0];
  const pendingKeptTrigger = pendingMarkup.match(
    /<button id="library-kept-duplicates-trigger"[^>]*>/,
  )?.[0];
  expect(pendingUnreviewedTrigger).toContain('disabled=""');
  expect(pendingKeptTrigger).toContain('disabled=""');
});

test("restores saved-view focus to the mounted compact trigger and uses search on desktop", () => {
  const calls: string[] = [];
  const compactTrigger = { focus: () => calls.push("compact-facets") };
  const desktopSearch = { focus: () => calls.push("desktop-search") };

  expect(
    restoreSaveViewDialogFocus(true, false, compactTrigger, desktopSearch),
  ).toBe(true);
  expect(calls).toEqual(["compact-facets"]);

  expect(
    restoreSaveViewDialogFocus(true, false, null, desktopSearch),
  ).toBe(true);
  expect(calls).toEqual(["compact-facets", "desktop-search"]);

  expect(
    restoreSaveViewDialogFocus(false, false, compactTrigger, desktopSearch),
  ).toBe(false);
  expect(calls).toEqual(["compact-facets", "desktop-search"]);
});

test("composes authoritative facets, table query state, selection, and inspector", () => {
  const markup = renderWorkspace();

  expect(markup).toContain('aria-label="Library workspace"');
  expect(markup).toContain('aria-label="Library filters and virtual libraries"');
  expect(markup).toContain('aria-label="Author, 17 books"');
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain('value="Dune"');
  expect(markup).toContain('<option value="rating" selected="">Rating</option>');
  expect(markup).toContain('aria-label="Change sort direction to ascending"');
  expect(markup).toContain(">Descending</button>");
  expect(markup).toContain("26–26 of 42");
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain("Selected book");
  expect(markup).toContain("Title");
});

test("renders a first-use experience instead of the catalogue when the ready library is empty", () => {
  const emptyFilters: LibraryQueryFilters = {
    authors: [],
    tags: [],
    series: [],
    languages: [],
    formats: [],
  };
  const markup = renderWorkspace({
    filters: emptyFilters,
    items: [],
    query: "",
    selectedItemId: null,
    selectedItemIds: [],
    total: 0,
    onOpenImport: () => undefined,
  });

  expect(markup).toContain("Add your first books to Takio");
  expect(markup).toContain(">Add books</button>");
  expect(markup).toContain("Drop files anywhere in this window");
  expect(markup).toContain("EPUB, PDF, MOBI, AZW3, CBZ, CBR, TXT, HTML");
  expect(markup).toContain("Takio copies imported books into its managed library");
  expect(markup).toContain("Advanced file handling is available during import");
  expect(markup).not.toContain('aria-label="Library workspace"');
  expect(markup).not.toContain('class="library-table"');
});

test("keeps no-results recovery distinct from the first-use state", () => {
  const emptyFilters: LibraryQueryFilters = {
    authors: [],
    tags: [],
    series: [],
    languages: [],
    formats: [],
  };
  const markup = renderWorkspace({
    filters: emptyFilters,
    items: [],
    query: "missing",
    selectedItemId: null,
    selectedItemIds: [],
    total: 0,
  });

  expect(markup).toContain("No matches");
  expect(markup).toContain("Clear search and filters");
  expect(markup).not.toContain("Add your first books to Takio");
  expect(markup).toContain('aria-label="Library workspace"');
});

test("surfaces library tools and active filter chips with removal labels", () => {
  const markup = renderWorkspace();

  expect(markup).toContain('aria-label="Library tools"');
  expect(markup).toContain(">Library tools</summary>");
  expect(markup).toContain("Active filters");
  expect(markup).toContain('aria-label="Remove Authors filter Author"');
  expect(markup).toContain("Authors: Author");
  expect(markup).toContain(">Clear all</button>");
});

test("threads controlled multi-selection state into the library table", () => {
  const markup = renderWorkspace();

  expect(markup).toContain('aria-label="Select current page" checked=""');
  expect(markup).toContain('aria-label="Select Title" checked=""');
});

test("renders controlled bulk actions and tag-dialog state for the exact selection", () => {
  const bulkActions = {
    pendingAction: "tags",
    canConvert: true,
    canSend: false,
    exportDialogOpen: false,
    exportSelectedCount: 0,
    tagsDialogOpen: true,
    tagsDialogError: "One update failed.",
    metadataDialogOpen: false,
    metadataDialogError: null,
    metadataCandidateDialogOpen: false,
    metadataCandidateItemIds: [],
    onExport: () => undefined,
    onEditTags: () => undefined,
    onEditMetadata: () => undefined,
    onReviewMetadata: () => undefined,
    onConvert: () => undefined,
    onSend: () => undefined,
    onMoveToTrash: () => undefined,
    onClearSelection: () => undefined,
    onCloseTagsDialog: () => undefined,
    onCloseMetadataDialog: () => undefined,
    onCloseMetadataCandidateDialog: () => undefined,
    onCloseExportDialog: () => undefined,
    onConfirmExport: () => undefined,
    onApplyTags: () => undefined,
    onApplyMetadata: () => undefined,
    onMetadataCandidateApplied: () => undefined,
  } as const satisfies NonNullable<LibraryWorkspaceProps["bulkActions"]>;

  const markup = renderWorkspace({
    selectedItemIds: [item.id, "off-page"],
    bulkActions,
  });

  expect(markup).toContain('aria-label="Bulk actions" aria-busy="true"');
  expect(markup).toContain("2 books selected");
  expect(markup).toContain("Updating tags…");
  expect(markup).toContain(">Save to disk…</button>");
  expect(markup).toContain(">Edit metadata…</button>");
  expect(markup).toContain('title="Copy every attached format to a folder"');
  expect(markup).toContain('title="Sending is not available for this selection"');
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain("Update tags for <strong>2 books</strong>");
  expect(markup).toContain("One update failed.");
});

test("renders bulk metadata as a distinct controlled workflow with safe shared fields", () => {
  const markup = renderWorkspace({
    selectedItemIds: [item.id, "off-page"],
    bulkActions: {
      pendingAction: "metadata",
      canConvert: true,
      canSend: true,
      exportDialogOpen: false,
      exportSelectedCount: 0,
      tagsDialogOpen: false,
      tagsDialogError: null,
      metadataDialogOpen: true,
      metadataDialogError: "One metadata update failed.",
      metadataCandidateDialogOpen: false,
      metadataCandidateItemIds: [],
      onExport: () => undefined,
      onEditTags: () => undefined,
      onEditMetadata: () => undefined,
      onReviewMetadata: () => undefined,
      onConvert: () => undefined,
      onSend: () => undefined,
      onMoveToTrash: () => undefined,
      onClearSelection: () => undefined,
      onCloseTagsDialog: () => undefined,
      onCloseMetadataDialog: () => undefined,
      onCloseMetadataCandidateDialog: () => undefined,
      onCloseExportDialog: () => undefined,
      onConfirmExport: () => undefined,
      onApplyTags: () => undefined,
      onApplyMetadata: () => undefined,
      onMetadataCandidateApplied: () => undefined,
    },
  });

  expect(markup).toContain("Updating metadata…");
  expect(markup).toContain("Update metadata for <strong>2 books</strong>");
  expect(markup).toContain("One metadata update failed.");
  for (const field of ["Publisher", "Series", "Series index", "Rating", "Languages"]) {
    expect(markup).toContain(`<legend>${field}</legend>`);
  }
  expect(markup).not.toMatch(/<legend>(?:Title|Authors|Tags)<\/legend>/);
});

test("renders the export preset dialog with its snapshotted count", () => {
  const markup = renderWorkspace({
    selectedItemIds: [item.id],
    bulkActions: {
      pendingAction: null,
      canConvert: true,
      canSend: true,
      exportDialogOpen: true,
      exportSelectedCount: 3,
      tagsDialogOpen: false,
      tagsDialogError: null,
      metadataDialogOpen: false,
      metadataDialogError: null,
      metadataCandidateDialogOpen: false,
      metadataCandidateItemIds: [],
      onExport: () => undefined,
      onEditTags: () => undefined,
      onEditMetadata: () => undefined,
      onReviewMetadata: () => undefined,
      onConvert: () => undefined,
      onSend: () => undefined,
      onMoveToTrash: () => undefined,
      onClearSelection: () => undefined,
      onCloseTagsDialog: () => undefined,
      onCloseMetadataDialog: () => undefined,
      onCloseMetadataCandidateDialog: () => undefined,
      onCloseExportDialog: () => undefined,
      onConfirmExport: () => undefined,
      onApplyTags: () => undefined,
      onApplyMetadata: () => undefined,
      onMetadataCandidateApplied: () => undefined,
    },
  });

  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain("Choose filename style");
  expect(markup).toContain("3 books");
  expect(markup).toContain('value="author-title"');
});

test("omits bulk controls without the controlled integration and disables library input globally", () => {
  expect(renderWorkspace({ bulkActions: undefined })).not.toContain(
    'aria-label="Bulk actions"',
  );

  const markup = renderWorkspace({
    actionsPending: true,
    bulkActions: {
      pendingAction: null,
      canConvert: true,
      canSend: true,
      exportDialogOpen: false,
      exportSelectedCount: 0,
      tagsDialogOpen: false,
      tagsDialogError: null,
      metadataDialogOpen: false,
      metadataDialogError: null,
      metadataCandidateDialogOpen: false,
      metadataCandidateItemIds: [],
      onExport: () => undefined,
      onEditTags: () => undefined,
      onEditMetadata: () => undefined,
      onReviewMetadata: () => undefined,
      onConvert: () => undefined,
      onSend: () => undefined,
      onMoveToTrash: () => undefined,
      onClearSelection: () => undefined,
      onCloseTagsDialog: () => undefined,
      onCloseMetadataDialog: () => undefined,
      onCloseMetadataCandidateDialog: () => undefined,
      onCloseExportDialog: () => undefined,
      onConfirmExport: () => undefined,
      onApplyTags: () => undefined,
      onApplyMetadata: () => undefined,
      onMetadataCandidateApplied: () => undefined,
    },
  });
  const search = markup.match(/<input[^>]*id="library-search"[^>]*>/)?.[0];

  expect(search).toContain('disabled=""');
  expect(markup).toContain('aria-label="Bulk actions" aria-busy="false"');
  expect(markup.match(/<button[^>]*disabled=""/g)?.length).toBeGreaterThanOrEqual(5);
});

test("preserves selected-book open, send, convert, format, cover, and removal actions", () => {
  const markup = renderWorkspace({
    items: [{ ...item, formats: [epub], sourcePath: epub.sourcePath, format: epub.format }],
    conversionDraft: { id: item.id, source: epub, target: "pdf" },
    preferredDeviceFormat: "pdf",
  });

  expect(markup).toContain('id="library-item-item-1"');
  expect(markup).toContain('id="library-primary-open-item-1"');
  expect(markup).toContain('id="library-convert-item-1-epub-to-pdf"');
  expect(markup).toContain('id="conversion-format-item-1"');
  expect(markup).toContain('aria-label="Open EPUB for Title"');
  expect(markup).toContain('aria-label="Send EPUB for Title"');
  expect(markup).toContain('aria-label="Convert EPUB to PDF for Title"');
  expect(markup).toContain("Import a copy…");
  expect(markup).toContain("Attach a reference…");
  expect(markup).toContain("Choose cover…");
  expect(markup).toContain("Add another format before removing the last one.");
  expect(markup).toContain("Move to Trash");
  expect(markup).not.toContain("Remove from library");
  expect(markup).toContain(
    'aria-label="Convert EPUB to PDF for “Title” before sending to Reader"',
  );
});

test("describes the reversible item action truthfully while it is pending", () => {
  const markup = renderWorkspace({
    actionsPending: true,
    pendingAction: `remove:${item.id}`,
  });

  expect(markup).toContain("Moving to Trash…");
  expect(markup).not.toContain("Removing…");
});

test("renders an explicit error instead of retaining rows that may belong to failed query intent", () => {
  const markup = renderWorkspace({ libraryState: "error" });

  expect(markup).toContain("Library unavailable");
  expect(markup).toContain("Try again");
  expect(markup).not.toContain("<table");
  expect(markup).not.toContain("26–26 of 42");
});

test("renders App-controlled metadata draft and save-view dialog state", () => {
  const markup = renderWorkspace({
    draft: { id: item.id, ...draftFor(item) },
    saveViewDialogOpen: true,
    saveViewDialogBusy: true,
    saveViewDialogError: "Name already exists.",
  });

  expect(markup).toContain("Edit metadata");
  expect(markup).toContain('id="metadata-item-1-title"');
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain("Dune favourites");
  expect(markup).toContain("Name already exists.");
  expect(markup).toContain("Saving…");
});

test("general send resolution never silently falls back from the session preference", () => {
  expect(resolveGeneralSend([epub, pdf], null)).toEqual({ kind: "no-preference" });
  expect(resolveGeneralSend([epub, pdf], "pdf")).toEqual({
    kind: "attached",
    bookFormat: pdf,
  });
  expect(resolveGeneralSend([epub], "pdf")).toEqual({
    kind: "convertible",
    source: epub,
    target: "pdf",
  });
  expect(resolveGeneralSend([epub], "azw3")).toEqual({
    kind: "unavailable",
    preferred: "azw3",
  });
});
