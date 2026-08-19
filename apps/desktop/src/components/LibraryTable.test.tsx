import { expect, test } from "bun:test";
import type { LibraryQuerySort } from "@takio/library-contract";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryTable,
  handleLibraryItemCheckboxClick,
  libraryPageRange,
  libraryPageTarget,
  nextLibrarySort,
  rowNavigationTarget,
} from "./LibraryTable";

const items = [
  {
    id: "item-1",
    title: "The Left Hand & Darkness",
    sourcePath: "/Books/left-hand.epub",
    format: "epub",
    addedAt: "2026-07-18T12:00:00.000Z",
    formats: [
      {
        sourcePath: "/Books/left-hand.epub",
        format: "epub",
        addedAt: "2026-07-18T12:00:00.000Z",
        provenance: "managed",
      },
      {
        sourcePath: "/Books/left-hand.pdf",
        format: "pdf",
        addedAt: "2026-07-19T12:00:00.000Z",
        provenance: "managed",
      },
    ],
    author: "Legacy author",
    authors: [
      { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
      { name: "Second Author" },
    ],
    description: "A novel",
    coverPath: "/Covers/left-hand.jpg",
    tags: ["Science fiction"],
  },
  {
    id: "item-2",
    title: "Kindred",
    sourcePath: "/Books/kindred.epub",
    format: "epub",
    addedAt: "2026-07-19T12:00:00.000Z",
    formats: [
      {
        sourcePath: "/Books/kindred.epub",
        format: "epub",
        addedAt: "2026-07-19T12:00:00.000Z",
        provenance: "managed",
      },
    ],
    author: "Octavia E. Butler",
    tags: [],
  },
] as const;

const titleSort = {
  field: "title",
  direction: "ascending",
} as const satisfies LibraryQuerySort;

function renderTable(
  options: {
    readonly sort?: LibraryQuerySort;
    readonly total?: number;
    readonly pageOffset?: number;
    readonly pageLimit?: number;
    readonly selectedItemId?: string | null;
    readonly selectedItemIds?: readonly string[];
  } = {},
): string {
  return renderToStaticMarkup(
    <LibraryTable
      items={items}
      sort={options.sort ?? titleSort}
      total={options.total ?? items.length}
      pageOffset={options.pageOffset ?? 0}
      pageLimit={options.pageLimit ?? 25}
      selectedItemId={options.selectedItemId ?? "item-1"}
      selectedItemIds={options.selectedItemIds ?? []}
      onChangePage={() => undefined}
      onChangeSort={() => undefined}
      onOpenItem={() => undefined}
      onSelectItem={() => undefined}
      onToggleItem={() => undefined}
      onSelectRange={() => undefined}
      onTogglePage={() => undefined}
    />,
  );
}

test("renders accessible server-controlled sorting for visible and hidden fields", () => {
  const markup = renderTable();

  expect(markup).toContain('<select aria-label="Sort field">');
  expect(markup).toContain('<option value="series">Series</option>');
  expect(markup).toContain('<option value="publishedDate">Published</option>');
  expect(markup).toContain('<option value="rating">Rating</option>');
  expect(markup).toContain('<option value="updatedAt">Updated</option>');
  expect(markup).toContain('aria-label="Sort by Title descending"');
  expect(markup).toContain('aria-label="Sort by Author ascending"');
  expect(markup.match(/aria-sort=/g)).toHaveLength(1);
  expect(markup).toContain('aria-sort="ascending"');

  expect(nextLibrarySort(titleSort, "title")).toEqual({
    field: "title",
    direction: "descending",
  });
  expect(nextLibrarySort(titleSort, "author")).toEqual({
    field: "author",
    direction: "ascending",
  });
});

test("renders rich authors, a real cover with escaped alt text, and legacy fallbacks", () => {
  const markup = renderTable();

  expect(markup).toContain("Ursula K. Le Guin, Second Author");
  expect(markup).not.toContain("Legacy author");
  expect(markup).toContain("Octavia E. Butler");
  expect(markup).toContain('<img class="library-table__cover"');
  expect(markup).toContain('alt="Cover of The Left Hand &amp; Darkness"');
  expect(markup).not.toContain('alt="/Covers/left-hand.jpg"');
  expect(markup).toContain("EPUB");
  expect(markup).toContain("PDF");
});

test("reports truthful page ranges and only emits offsets inside the result set", () => {
  expect(libraryPageRange(25, 25, 51)).toEqual({ start: 26, end: 50 });
  expect(libraryPageRange(50, 1, 51)).toEqual({ start: 51, end: 51 });
  expect(libraryPageRange(0, 0, 0)).toEqual({ start: 0, end: 0 });

  expect(libraryPageTarget("previous", 25, 25, 51)).toBe(0);
  expect(libraryPageTarget("next", 25, 25, 51)).toBe(50);
  expect(libraryPageTarget("previous", 0, 25, 51)).toBeNull();
  expect(libraryPageTarget("next", 50, 25, 51)).toBeNull();

  const firstPage = renderTable({ total: 51 });
  expect(firstPage).toContain("1–2 of 51");
  expect(firstPage).toMatch(/<button type="button" disabled="">Previous<\/button>/);
  expect(firstPage).toMatch(/<button type="button">Next<\/button>/);

  const lastPage = renderTable({ total: 51, pageOffset: 50 });
  expect(lastPage).toContain("51–51 of 51");
  expect(lastPage).toMatch(/<button type="button" disabled="">Next<\/button>/);
});

test("keeps exactly one selected row in the tab order", () => {
  const markup = renderTable({ selectedItemId: "item-2" });

  expect(markup).toContain('aria-selected="true"');
  expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
});

test("renders explicit page and row selection independently from the active row", () => {
  const markup = renderTable({ selectedItemId: "item-2", selectedItemIds: ["item-1"] });

  expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
  expect(markup).toContain('aria-label="Select current page"');
  expect(markup).toContain('aria-label="Select The Left Hand &amp; Darkness" checked=""');
  expect(markup).toContain('aria-label="Select Kindred"');
  expect(markup).toContain('id="library-item-item-2" aria-selected="true"');

  const allSelected = renderTable({ selectedItemIds: items.map(({ id }) => id) });
  expect(allSelected.match(/checked=""/g)).toHaveLength(3);
});

test("routes checkbox clicks to one-item or page-bounded range selection without row activation", () => {
  const calls: string[] = [];
  const pageItemIds = items.map(({ id }) => id);

  handleLibraryItemCheckboxClick(
    { shiftKey: false, stopPropagation: () => calls.push("stopped") },
    "item-1",
    pageItemIds,
    (id) => calls.push(`toggle:${id}`),
    (id, ids) => calls.push(`range:${id}:${ids.join(",")}`),
  );
  handleLibraryItemCheckboxClick(
    { shiftKey: true, stopPropagation: () => calls.push("stopped") },
    "item-2",
    pageItemIds,
    (id) => calls.push(`toggle:${id}`),
    (id, ids) => calls.push(`range:${id}:${ids.join(",")}`),
  );

  expect(calls).toEqual([
    "stopped",
    "toggle:item-1",
    "stopped",
    "range:item-2:item-1,item-2",
  ]);
});

test("defines bounded arrow, Home, and End navigation because selection must not wrap", () => {
  expect(rowNavigationTarget("ArrowDown", 0, 2)).toBe(1);
  expect(rowNavigationTarget("ArrowDown", 1, 2)).toBe(1);
  expect(rowNavigationTarget("ArrowUp", 0, 2)).toBe(0);
  expect(rowNavigationTarget("ArrowUp", 1, 2)).toBe(0);
  expect(rowNavigationTarget("Home", 1, 2)).toBe(0);
  expect(rowNavigationTarget("End", 0, 2)).toBe(1);
  expect(rowNavigationTarget("End", 0, 0)).toBeNull();
});
