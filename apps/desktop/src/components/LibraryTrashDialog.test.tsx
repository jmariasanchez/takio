import { expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryTrashDialog,
  trashDialogFocusTarget,
  trashPageRange,
  trashPageTarget,
} from "./LibraryTrashDialog";

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
        provenance: "referenced",
      },
    ],
    authors: [{ name: "Ursula K. Le Guin" }],
    tags: ["Science fiction"],
  },
  {
    id: "item-2",
    title: "Kindred",
    sourcePath: "/Books/kindred.mobi",
    format: "mobi",
    addedAt: "2026-07-19T12:00:00.000Z",
    formats: [
      {
        sourcePath: "/Books/kindred.mobi",
        format: "mobi",
        addedAt: "2026-07-19T12:00:00.000Z",
        provenance: "managed",
      },
    ],
    author: "Octavia E. Butler",
    tags: [],
  },
] as const satisfies readonly LibraryItem[];

function render(
  overrides: Partial<Parameters<typeof LibraryTrashDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <LibraryTrashDialog
      open
      items={items}
      total={42}
      pageOffset={20}
      pageLimit={20}
      loading={false}
      pendingItemId={null}
      pendingAction={null}
      error={null}
      onClose={() => undefined}
      onChangePage={() => undefined}
      onRestore={() => undefined}
      onPurge={() => undefined}
      {...overrides}
    />,
  );
}

test("renders a labelled, dense modal with visible and paged totals", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];

  expect(titleId).toBeDefined();
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Trash</h2>`);
  expect(markup).toContain("2 visible");
  expect(markup).toContain("42 total");
  expect(markup).toContain("21–22 of 42");
  expect(markup).toContain('<nav aria-label="Trash pages">');
  expect(markup).toContain('<button type="button">Previous</button>');
  expect(markup).toContain('<button type="button">Next</button>');
});

test("shows title, authoritative author, formats, and only lifecycle actions", () => {
  const markup = render();

  expect(markup).toContain("The Left Hand of Darkness");
  expect(markup).toContain("Ursula K. Le Guin");
  expect(markup).toContain("Kindred");
  expect(markup).toContain("Octavia E. Butler");
  expect(markup).toContain(">EPUB<");
  expect(markup).toContain(">PDF<");
  expect(markup).toContain(">MOBI<");
  expect(markup).toContain('aria-label="Restore The Left Hand of Darkness"');
  expect(markup).toContain('aria-label="Permanently delete The Left Hand of Darkness"');
  expect(markup).toContain(
    "Permanently delete <strong>The Left Hand of Darkness</strong>? This cannot be undone.",
  );
  expect(markup).toContain(
    'aria-label="Confirm permanent deletion of The Left Hand of Darkness" hidden="" inert=""',
  );
  expect(markup).toContain("Delete forever");
  expect(markup).not.toMatch(/reader|viewer|open book/i);
});

test("exposes loading, pending action, errors, and disabled paging", () => {
  const loadingMarkup = render({ loading: true, error: "Trash could not be loaded." });
  const pendingMarkup = render({ pendingItemId: "item-2", pendingAction: "restore" });
  const purgeMarkup = render({ pendingItemId: "item-1", pendingAction: "purge" });

  expect(loadingMarkup).toContain('aria-busy="true"');
  expect(loadingMarkup).toContain(
    'role="status" aria-live="polite" aria-atomic="true">Loading Trash…',
  );
  expect(loadingMarkup).toContain('role="alert">Trash could not be loaded.</p>');
  expect(loadingMarkup).toContain('<button type="button" disabled="">Previous</button>');
  expect(loadingMarkup).toContain('<button type="button" disabled="">Next</button>');
  expect(pendingMarkup).toContain("Restoring Kindred…");
  expect(pendingMarkup).toContain('aria-label="Restore Kindred">Restoring…</button>');
  expect(purgeMarkup).toContain("Deleting The Left Hand of Darkness…");
  expect(purgeMarkup).toContain(">Deleting…</button>");
});

test("renders an explicit empty state and nothing while closed", () => {
  const emptyMarkup = render({ items: [], total: 0, pageOffset: 0 });

  expect(emptyMarkup).toContain("Trash is empty");
  expect(emptyMarkup).toContain("0 visible");
  expect(emptyMarkup).toContain("0 of 0");
  expect(render({ open: false })).toBe("");
});

test("wraps focus and computes bounded page targets", () => {
  expect(trashDialogFocusTarget(0, 4, true)).toBe(3);
  expect(trashDialogFocusTarget(3, 4, false)).toBe(0);
  expect(trashDialogFocusTarget(1, 4, false)).toBeNull();
  expect(trashDialogFocusTarget(-1, 4, false)).toBe(0);
  expect(trashDialogFocusTarget(-1, 4, true)).toBe(3);
  expect(trashDialogFocusTarget(0, 0, false)).toBeNull();

  expect(trashPageRange(20, 2, 42)).toEqual({ start: 21, end: 22 });
  expect(trashPageRange(0, 0, 0)).toEqual({ start: 0, end: 0 });
  expect(trashPageTarget("previous", 20, 20, 42)).toBe(0);
  expect(trashPageTarget("previous", 0, 20, 42)).toBeNull();
  expect(trashPageTarget("next", 20, 20, 42)).toBe(40);
  expect(trashPageTarget("next", 40, 20, 42)).toBeNull();
  expect(trashPageTarget("next", 0, 0, 42)).toBeNull();
});
