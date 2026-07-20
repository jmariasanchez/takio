import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryBulkTagsDialog,
  bulkTagsDialogFocusTarget,
  parseBulkLibraryTags,
  validateBulkLibraryTags,
} from "./LibraryBulkTagsDialog";

function render(
  overrides: Partial<Parameters<typeof LibraryBulkTagsDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <LibraryBulkTagsDialog
      open
      selectedCount={3}
      pending={false}
      error={null}
      onClose={() => undefined}
      onApply={() => undefined}
      {...overrides}
    />,
  );
}

test("renders a labelled bulk tag modal with the exact controlled selection", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
  const tagsId = markup.match(/<label for="([^"]+)">Tags<\/label>/)?.[1];

  expect(titleId).toBeDefined();
  expect(tagsId).toBeDefined();
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Edit tags</h2>`);
  expect(markup).toContain("Update tags for <strong>3 books</strong>.");
  expect(markup).toContain(`<textarea id="${tagsId}"`);
  expect(markup).toContain('name="library-bulk-tags"');
  expect(markup).toContain('<button type="submit">Apply tags</button>');
  expect(markup).not.toMatch(/reader|viewer|open book/i);
});

test("offers explicit add, remove, and replace operations with guarded clearing", () => {
  const markup = render({ selectedCount: 1 });

  expect(markup).toMatch(/checked="" value="add"/);
  expect(markup).toContain('value="remove"');
  expect(markup).toContain('value="replace"');
  expect(markup).toContain("Keep existing tags and add these tags.");
  expect(markup).toContain("Remove only these tags from each book.");
  expect(markup).toContain("Replace every existing tag with this complete list.");
  expect(markup).toContain('class="library-bulk-tags-dialog__clear" hidden=""');
  expect(markup).toContain("Allow an empty replacement");
  expect(markup).toContain("This clears every tag from all 1 book.");
});

test("normalizes whitespace and deduplicates tags case-insensitively", () => {
  expect(parseBulkLibraryTags("  Science   Fiction, Classic, science fiction ")).toEqual([
    "Science Fiction",
    "Classic",
  ]);
  expect(parseBulkLibraryTags("  ")).toEqual([]);
  expect(() => parseBulkLibraryTags("Classic,")).toThrow();
  expect(() => parseBulkLibraryTags(",Classic")).toThrow();
});

test("requires tags for add and remove and confirms an empty replacement", () => {
  expect(validateBulkLibraryTags("add", "", false)).toEqual({
    tags: null,
    error: "Enter at least one tag to add.",
  });
  expect(validateBulkLibraryTags("remove", "", false)).toEqual({
    tags: null,
    error: "Enter at least one tag to remove.",
  });
  expect(validateBulkLibraryTags("replace", "", false)).toEqual({
    tags: null,
    error: "Confirm that you want to clear all tags.",
  });
  expect(validateBulkLibraryTags("replace", "", true)).toEqual({
    tags: [],
    error: null,
  });
  expect(validateBulkLibraryTags("replace", " Classic, classic ", false)).toEqual({
    tags: ["Classic"],
    error: null,
  });
  expect(validateBulkLibraryTags("add", "Classic,", false)).toEqual({
    tags: null,
    error: "Enter comma-separated tags without empty entries.",
  });
});

test("exposes pending and external errors while leaving close available", () => {
  const markup = render({
    selectedCount: 2,
    pending: true,
    error: "Tags could not be updated.",
  });

  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('fieldset class="library-bulk-tags-dialog__operations" disabled=""');
  expect(markup).toMatch(/<textarea[^>]+disabled="" aria-invalid="true"/);
  expect(markup).toContain(
    'role="status" aria-live="polite" aria-atomic="true">Updating tags for 2 books…',
  );
  expect(markup).toContain('role="alert">Tags could not be updated.</p>');
  expect(markup).toContain('<button type="submit" disabled="">Updating…</button>');
  expect(markup).toContain('<button type="button">Cancel</button>');
});

test("renders nothing while closed and wraps modal focus", () => {
  expect(render({ open: false })).toBe("");
  expect(bulkTagsDialogFocusTarget(0, 4, true)).toBe(3);
  expect(bulkTagsDialogFocusTarget(3, 4, false)).toBe(0);
  expect(bulkTagsDialogFocusTarget(1, 4, true)).toBeNull();
  expect(bulkTagsDialogFocusTarget(-1, 4, false)).toBe(0);
  expect(bulkTagsDialogFocusTarget(-1, 4, true)).toBe(3);
  expect(bulkTagsDialogFocusTarget(0, 0, false)).toBeNull();
});
