import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import type {
  LibraryFacetCounts,
  LibraryQueryFilters,
  LibraryQuerySort,
} from "@takio/library-contract";
import { renderToStaticMarkup } from "react-dom/server";

import type { CompactPane } from "./CompactPaneDrawer";
import { LibraryFacetSidebar } from "./LibraryFacetSidebar";
import { LibraryInspector } from "./LibraryInspector";
import { LibraryTable } from "./LibraryTable";
import { LibraryWorkspaceLayout } from "./LibraryWorkspaceLayout";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function setCompactLayout(compact: boolean): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        convertFileSrc: (filePath: string, protocol: string) =>
          `${protocol}://localhost/${encodeURIComponent(filePath)}`,
      },
      matchMedia: (query: string) => ({
        matches: compact && query === "(max-width: 900px)",
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    },
  });
}

beforeAll(() => {
  setCompactLayout(false);
});

afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

const items = [
  {
    id: "book-1",
    title: "Kindred",
    sourcePath: "/Books/kindred.epub",
    format: "epub",
    formats: [
      {
        sourcePath: "/Books/kindred.epub",
        format: "epub",
        provenance: "managed",
        addedAt: "2026-07-18T12:00:00.000Z",
      },
    ],
    authors: [{ name: "Octavia E. Butler" }],
    addedAt: "2026-07-18T12:00:00.000Z",
    tags: ["Classic"],
  },
  {
    id: "book-2",
    title: "The Dispossessed",
    sourcePath: "/Books/dispossessed.pdf",
    format: "pdf",
    formats: [
      {
        sourcePath: "/Books/dispossessed.pdf",
        format: "pdf",
        provenance: "referenced",
        addedAt: "2026-07-19T12:00:00.000Z",
      },
    ],
    authors: [{ name: "Ursula K. Le Guin" }],
    addedAt: "2026-07-19T12:00:00.000Z",
    tags: ["Science fiction"],
  },
] as const satisfies readonly LibraryItem[];

const facets: LibraryFacetCounts = {
  authors: [
    { value: "Octavia E. Butler", count: 1 },
    { value: "Ursula K. Le Guin", count: 1 },
  ],
  tags: [{ value: "Classic", count: 1 }],
  series: [],
  languages: [],
  formats: [
    { value: "epub", count: 1 },
    { value: "pdf", count: 1 },
  ],
};

const filters: LibraryQueryFilters = {
  authors: ["Octavia E. Butler"],
  tags: [],
  series: [],
  languages: [],
  formats: [],
};

const sort = {
  field: "title",
  direction: "ascending",
} as const satisfies LibraryQuerySort;

function facetSidebar() {
  return (
    <LibraryFacetSidebar
      facets={facets}
      filters={filters}
      savedViews={[]}
      currentSavedViewId={null}
      onChangeFilters={() => undefined}
      onClearAll={() => undefined}
      onApplySavedView={() => undefined}
      onSaveSavedView={() => undefined}
      onRemoveSavedView={() => undefined}
    />
  );
}

function inspector() {
  return (
    <LibraryInspector
      item={items[0]}
      onConvertFormat={() => undefined}
      onOpenFormat={() => undefined}
      onSendFormat={() => undefined}
    />
  );
}

function renderLibrary(openPane: CompactPane | null = null, compact = true): string {
  setCompactLayout(compact);
  return renderToStaticMarkup(
    <LibraryWorkspaceLayout
      facets={facetSidebar()}
      inspector={inspector()}
      openPane={openPane}
      table={
        <LibraryTable
          items={items}
          sort={sort}
          total={42}
          pageOffset={0}
          pageLimit={25}
          selectedItemId="book-2"
          onChangePage={() => undefined}
          onChangeSort={() => undefined}
          onOpenItem={() => undefined}
          onSelectItem={() => undefined}
        />
      }
      toolbar={<input aria-label="Search library" />}
      onOpenPaneChange={() => undefined}
    />,
  );
}

function attributeValues(markup: string, attribute: string): string[] {
  return Array.from(markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g")), ([, value]) =>
    value,
  );
}

test("keeps the library table to one row tab stop without introducing a reading action", () => {
  const markup = renderLibrary();
  const rows = Array.from(
    markup.matchAll(/<tr\b[^>]*class="[^"]*library-table__row[^"]*"[^>]*>/g),
    ([tag]) => tag,
  );

  expect(rows).toHaveLength(items.length);
  expect(rows.filter((row) => row.includes('tabindex="0"'))).toHaveLength(1);
  expect(rows.filter((row) => row.includes('tabindex="-1"'))).toHaveLength(items.length - 1);
  expect(markup).not.toMatch(/aria-label="(?:read|continue reading|open reader)\b/i);
  expect(markup).not.toMatch(/<button\b[^>]*>\s*(?:read|continue reading)\s*<\/button>/i);
  expect(markup).not.toContain('role="document"');
});

test("preserves table sorting, paging, and facet semantics in compact composition", () => {
  const markup = renderLibrary("facets");

  expect(markup).toContain("<caption>Library books</caption>");
  expect(markup.match(/scope="col"/g)).toHaveLength(5);
  expect(markup.match(/aria-sort=/g)).toHaveLength(1);
  expect(markup).toContain('aria-sort="ascending"');
  expect(markup).toContain('<select aria-label="Sort field">');
  expect(markup).toContain('role="navigation" aria-label="Library pages"');
  expect(markup).toContain('<span aria-live="polite">1–2 of 42</span>');
  expect(markup).toMatch(/<button type="button" disabled="">Previous<\/button>/);
  expect(markup).toMatch(/<button type="button">Next<\/button>/);
  expect(markup).toContain(
    '<nav class="library-facets" aria-label="Library filters and saved views">',
  );
  expect(markup).toMatch(
    /<input type="checkbox"[^>]*aria-label="Octavia E\. Butler, 1 book"[^>]*checked=""/,
  );
  expect(markup).toMatch(
    /<input type="checkbox"[^>]*aria-label="Ursula K\. Le Guin, 1 book"(?![^>]*checked)/,
  );
});

test("makes every inactive compact pane and its controls hidden and inert", () => {
  const closedMarkup = renderLibrary();
  const facetsMarkup = renderLibrary("facets");

  expect(closedMarkup).toContain('compact-pane-drawer__overlay" hidden="" inert=""');
  expect(closedMarkup.match(/role="dialog"[^>]+hidden="" inert=""/g)).toHaveLength(2);
  expect(facetsMarkup.match(/role="dialog"[^>]+aria-modal="true"/g)).toHaveLength(1);
  expect(facetsMarkup.match(/role="dialog"[^>]+hidden="" inert=""/g)).toHaveLength(1);
  expect(facetsMarkup).toMatch(
    /role="dialog"[^>]+hidden="" inert=""[^>]*>[\s\S]*?aria-label="Open EPUB for Kindred"/,
  );
});

test("requires a single instance of each responsive primitive for valid SSR references", () => {
  for (const markup of [renderLibrary(null, false), renderLibrary("inspector", true)]) {
    const ids = attributeValues(markup, "id");

    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of [
      ...attributeValues(markup, "aria-controls"),
      ...attributeValues(markup, "aria-labelledby"),
    ].flatMap((value) => value.split(" "))) {
      expect(ids.filter((id) => id === reference)).toHaveLength(1);
    }
  }
});
