import { expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import {
  MAX_LIBRARY_IMPORT_ROOTS,
  type LibraryImportReport,
} from "@takio/library-contract";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryImportDialog,
  canStartLibraryImport,
  importDialogFocusTarget,
} from "./LibraryImportDialog";

const importedItem = {
  id: "item-1",
  title: "The Left Hand of Darkness",
  sourcePath: "/books/left-hand.epub",
  format: "epub",
  formats: [
    {
      format: "epub",
      sourcePath: "/books/left-hand.epub",
      provenance: "managed",
      addedAt: "2026-07-20T12:00:00.000Z",
    },
  ],
  addedAt: "2026-07-20T12:00:00.000Z",
  author: "Ursula K. Le Guin",
  tags: ["Science fiction"],
} as const satisfies LibraryItem;

const report = {
  outcomes: [
    {
      status: "imported",
      sourcePath: "/books/left-hand.epub",
      item: importedItem,
      sourceCleanupPending: false,
    },
    {
      status: "skipped",
      sourcePath: "/books/cover.jpg",
      reason: "unsupported-format",
    },
    {
      status: "duplicate",
      sourcePath: "/books/copy.epub",
      existing: { itemId: importedItem.id, format: "epub" },
      reason: "earlier-in-request",
    },
    {
      status: "failed",
      sourcePath: "/books/missing.pdf",
      code: "not-found",
    },
  ],
  counts: { total: 4, imported: 1, skipped: 1, duplicates: 1, failed: 1 },
} as const satisfies LibraryImportReport;

function render(
  overrides: Partial<Parameters<typeof LibraryImportDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <LibraryImportDialog
      open
      selectedRootPaths={["/books", "/downloads/new.epub"]}
      pending={false}
      mode="copy"
      report={null}
      error={null}
      onClose={() => undefined}
      onChooseFiles={() => undefined}
      onChooseFolders={() => undefined}
      onImport={() => undefined}
      onModeChange={() => undefined}
      {...overrides}
    />,
  );
}

test("renders an accessible recursive-import modal with controlled root paths", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
  const describedByIds = markup.match(/aria-describedby="([^"]+)"/)?.[1].split(" ");

  expect(titleId).toBeDefined();
  expect(describedByIds).toHaveLength(2);
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  for (const id of describedByIds ?? []) {
    expect(markup).toContain(`id="${id}"`);
  }
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Import books</h2>`);
  expect(markup).toContain("Folders are scanned recursively");
  expect(markup).toContain("/books");
  expect(markup).toContain("/downloads/new.epub");
  expect(markup).toContain("2 selected roots");
  expect(markup).toContain('<button type="button">Choose files…</button>');
  expect(markup).toContain('<button type="button">Choose folders…</button>');
  expect(markup).toContain("Advanced file handling");
  expect(markup).toContain("Copy originals (recommended)");
  expect(markup).toContain('value="move"');
  expect(markup).toContain("Move originals into Takio");
  expect(markup).toContain("atomically moves books on the same drive");
  expect(markup).toContain("another drive stay in place");
  expect(markup).toContain(
    '<button type="button" class="library-import-dialog__import">Import into Takio</button>',
  );
});

test("does not render dialog controls while closed", () => {
  expect(render({ open: false })).toBe("");
});

test("shows pending and error state without allowing duplicate actions", () => {
  const markup = render({ pending: true, error: "Storage is unavailable." });

  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('role="status" aria-live="polite"');
  expect(markup).toContain("Importing 2 selected roots…");
  expect(markup).toContain('role="alert">Storage is unavailable.</p>');
  expect(markup).toContain('disabled="">Choose files…</button>');
  expect(markup).toContain('disabled="">Choose folders…</button>');
  expect(markup).toContain('disabled="">Importing…</button>');
});

test("renders exact counts and every ordered outcome discriminant", () => {
  const markup = render({ report });

  expect(markup).toContain('aria-label="Import counts"');
  expect(markup).toContain("4 total");
  expect(markup).toContain("1 imported");
  expect(markup).toContain("1 skipped");
  expect(markup).toContain("1 duplicate");
  expect(markup).toContain("1 failed");
  expect(markup).toContain('aria-label="Import results"');

  const importedIndex = markup.indexOf("/books/left-hand.epub");
  const skippedIndex = markup.indexOf("/books/cover.jpg");
  const duplicateIndex = markup.indexOf("/books/copy.epub");
  const failedIndex = markup.indexOf("/books/missing.pdf");
  expect(importedIndex).toBeGreaterThan(-1);
  expect(skippedIndex).toBeGreaterThan(importedIndex);
  expect(duplicateIndex).toBeGreaterThan(skippedIndex);
  expect(failedIndex).toBeGreaterThan(duplicateIndex);

  for (const status of ["imported", "skipped", "duplicate", "failed"]) {
    expect(markup).toContain(`<code>${status}</code>`);
  }
  expect(markup).toContain("The Left Hand of Darkness");
  expect(markup).toContain("<dt>Original</dt><dd>removed</dd>");
  expect(markup).toContain("<code>unsupported-format</code>");
  expect(markup).toContain("<code>earlier-in-request</code>");
  expect(markup).toContain("item-1 · EPUB");
  expect(markup).toContain("<code>not-found</code>");
});

test("requires a contract-bounded root selection before importing", () => {
  expect(canStartLibraryImport([], false)).toBe(false);
  expect(canStartLibraryImport(["/books"], false)).toBe(true);
  expect(
    canStartLibraryImport(
      Array.from({ length: MAX_LIBRARY_IMPORT_ROOTS }, (_, index) => `/book-${index}`),
      false,
    ),
  ).toBe(true);
  expect(
    canStartLibraryImport(
      Array.from({ length: MAX_LIBRARY_IMPORT_ROOTS + 1 }, (_, index) => `/book-${index}`),
      false,
    ),
  ).toBe(false);
  expect(canStartLibraryImport(["/books"], true)).toBe(false);
});

test("wraps modal focus at both boundaries and handles an empty control set", () => {
  expect(importDialogFocusTarget(0, 3, true)).toBe(2);
  expect(importDialogFocusTarget(2, 3, false)).toBe(0);
  expect(importDialogFocusTarget(1, 3, true)).toBeNull();
  expect(importDialogFocusTarget(1, 3, false)).toBeNull();
  expect(importDialogFocusTarget(-1, 3, true)).toBe(2);
  expect(importDialogFocusTarget(-1, 3, false)).toBe(0);
  expect(importDialogFocusTarget(0, 0, true)).toBeNull();
  expect(importDialogFocusTarget(0, 0, false)).toBeNull();
});
