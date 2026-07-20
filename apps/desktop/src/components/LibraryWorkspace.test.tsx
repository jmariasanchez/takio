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
    sort,
    total: 42,
    onApplySavedView: () => undefined,
    onAttachFormat: async () => undefined,
    onCancelSaveView: () => undefined,
    onChangeFilters: () => undefined,
    onChangePage: () => undefined,
    onChangeSearch: () => undefined,
    onChangeSort: () => undefined,
    onChooseCover: async () => undefined,
    onClearAll: () => undefined,
    onClearCover: async () => undefined,
    onEnqueueConversion: async () => undefined,
    onOpenItem: async () => undefined,
    onOpenSaveView: () => undefined,
    onRemoveFormat: async () => undefined,
    onRemoveItem: async () => undefined,
    onRemoveSavedView: () => undefined,
    onRetry: async () => true,
    onSaveMetadata: async () => undefined,
    onSaveView: () => undefined,
    onSelectItem: () => undefined,
    onSendItem: async () => undefined,
    onSetConversionDraft: () => undefined,
    onSetDraft: () => undefined,
    ...overrides,
  };
}

function renderWorkspace(overrides: Partial<LibraryWorkspaceProps> = {}): string {
  return renderToStaticMarkup(<LibraryWorkspace {...props(overrides)} />);
}

test("closes a compact pane before opening the saved-view modal so overlays cannot stack", () => {
  const calls: string[] = [];

  openSaveViewWithPaneClosed(
    (pane) => calls.push(`pane:${pane ?? "closed"}`),
    () => calls.push("dialog:open"),
  );

  expect(calls).toEqual(["pane:closed", "dialog:open"]);
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
  expect(markup).toContain('aria-label="Library filters and saved views"');
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
  expect(markup).toContain("Remove from library");
  expect(markup).toContain(
    'aria-label="Convert EPUB to PDF for “Title” before sending to Reader"',
  );
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
