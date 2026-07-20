import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryTable, rowNavigationTarget } from "./LibraryTable";

const items = [
  {
    id: "item-1",
    title: "The Left Hand of Darkness",
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
    author: "Ursula K. Le Guin",
    description: "A novel",
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

test("renders truthful library fields as a semantic table without fake controls", () => {
  const markup = renderToStaticMarkup(
    <LibraryTable
      items={items}
      selectedItemId="item-1"
      onOpenItem={() => undefined}
      onSelectItem={() => undefined}
    />,
  );

  expect(markup).toContain("<table");
  expect(markup).toContain("<caption>Library books</caption>");
  expect(markup).toContain('<th scope="col">Title</th>');
  expect(markup).toContain('<th scope="col">Author</th>');
  expect(markup).toContain('<th scope="col">Formats</th>');
  expect(markup).toContain('<th scope="col">Added</th>');
  expect(markup).toContain("The Left Hand of Darkness");
  expect(markup).toContain("Ursula K. Le Guin");
  expect(markup).toContain("EPUB");
  expect(markup).toContain("PDF");
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).not.toContain("Sort");
  expect(markup).not.toContain("Previous");
  expect(markup).not.toContain("Next");
  expect(markup).not.toContain("Read");
});

test("keeps exactly one row in the tab order", () => {
  const markup = renderToStaticMarkup(
    <LibraryTable
      items={items}
      selectedItemId="item-2"
      onOpenItem={() => undefined}
      onSelectItem={() => undefined}
    />,
  );

  expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
  expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
});

test("defines bounded row navigation because selection must not wrap unexpectedly", () => {
  expect(rowNavigationTarget("ArrowDown", 0, 2)).toBe(1);
  expect(rowNavigationTarget("ArrowDown", 1, 2)).toBe(1);
  expect(rowNavigationTarget("ArrowUp", 0, 2)).toBe(0);
  expect(rowNavigationTarget("ArrowUp", 1, 2)).toBe(0);
  expect(rowNavigationTarget("Home", 1, 2)).toBe(0);
  expect(rowNavigationTarget("End", 0, 2)).toBe(1);
  expect(rowNavigationTarget("End", 0, 0)).toBeNull();
});
