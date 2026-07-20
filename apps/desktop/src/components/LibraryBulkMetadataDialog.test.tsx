import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryBulkMetadataDialog,
  bulkMetadataDialogFocusTarget,
  validateBulkLibraryMetadata,
  type LibraryBulkMetadataDraft,
} from "./LibraryBulkMetadataDialog";

function unchangedDraft(): LibraryBulkMetadataDraft {
  return {
    publisher: { mode: "unchanged", value: "" },
    series: { mode: "unchanged", value: "" },
    seriesIndex: { mode: "unchanged", value: "" },
    rating: { mode: "unchanged", value: "" },
    languages: { mode: "unchanged", value: "" },
  };
}

function render(
  overrides: Partial<Parameters<typeof LibraryBulkMetadataDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <LibraryBulkMetadataDialog
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

test("renders an accessible modal with only safe shared metadata fields", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];

  expect(titleId).toBeDefined();
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Edit metadata</h2>`);
  expect(markup).toContain("Update metadata for <strong>3 books</strong>.");
  for (const field of ["Publisher", "Series", "Series index", "Rating", "Languages"]) {
    expect(markup).toContain(`<legend>${field}</legend>`);
    expect(markup).toContain(`aria-label="${field} change"`);
  }
  expect(markup).toContain('<option value="unchanged" selected="">Unchanged</option>');
  expect(markup).toContain('<option value="replace">Replace</option>');
  expect(markup).toContain('<option value="clear">Clear</option>');
  expect(markup).toContain("Unchanged fields keep each book&#x27;s current value.");
  expect(markup).not.toMatch(/<legend>(?:Title|Authors|Tags)<\/legend>/);
  expect(markup).not.toMatch(/reader|viewer|open book/i);
});

test("emits a normalized schema-validated patch for replacements and clears", () => {
  const draft: LibraryBulkMetadataDraft = {
    publisher: { mode: "replace", value: "  Ace Books  " },
    series: { mode: "clear", value: "ignored" },
    seriesIndex: { mode: "replace", value: " 4.5 " },
    rating: { mode: "replace", value: "8" },
    languages: { mode: "replace", value: " en-US, fr " },
  };

  const result = validateBulkLibraryMetadata(draft);
  expect(result.error).toBeNull();
  expect(result.fieldErrors).toEqual({});
  expect(result.patch as unknown).toEqual({
    publisher: "Ace Books",
    series: null,
    seriesIndex: 4.5,
    rating: 8,
    languages: ["en-US", "fr"],
  });
});

test("rejects no-op, blank, malformed, non-finite, and out-of-range replacements", () => {
  expect(validateBulkLibraryMetadata(unchangedDraft())).toEqual({
    patch: null,
    fieldErrors: {},
    error: "Choose at least one metadata field to replace or clear.",
  });

  const invalid: LibraryBulkMetadataDraft = {
    publisher: { mode: "replace", value: "   " },
    series: { mode: "unchanged", value: "" },
    seriesIndex: { mode: "replace", value: "Infinity" },
    rating: { mode: "replace", value: "11" },
    languages: { mode: "replace", value: "en-US," },
  };
  const result = validateBulkLibraryMetadata(invalid);

  expect(result.patch).toBeNull();
  expect(result.error).toBe("Correct the highlighted metadata fields.");
  expect(result.fieldErrors).toEqual({
    publisher: "Enter a publisher or choose Clear.",
    seriesIndex: "Enter a finite series index or choose Clear.",
    rating: "Enter a rating from 0 to 10 or choose Clear.",
    languages: "Enter comma-separated language tags without empty entries.",
  });

  const invalidLanguage = {
    ...unchangedDraft(),
    languages: { mode: "replace", value: "english" },
  } as const satisfies LibraryBulkMetadataDraft;
  expect(validateBulkLibraryMetadata(invalidLanguage).fieldErrors).toEqual({
    languages: "Use valid language tags such as en, en-US, or fr.",
  });
});

test("exposes pending and external errors while leaving close available", () => {
  const markup = render({
    selectedCount: 1,
    pending: true,
    error: "Metadata could not be updated.",
  });

  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('<fieldset disabled=""><legend>Publisher</legend>');
  expect(markup).toContain(
    'role="status" aria-live="polite" aria-atomic="true">Updating metadata for 1 book…',
  );
  expect(markup).toContain('role="alert">Metadata could not be updated.</p>');
  expect(markup).toContain('<button type="submit" disabled="">Updating…</button>');
  expect(markup).toContain('<button type="button">Cancel</button>');
  expect(markup).toContain('aria-label="Close metadata editor"');
});

test("renders nothing while closed and wraps modal focus", () => {
  expect(render({ open: false })).toBe("");
  expect(bulkMetadataDialogFocusTarget(0, 4, true)).toBe(3);
  expect(bulkMetadataDialogFocusTarget(3, 4, false)).toBe(0);
  expect(bulkMetadataDialogFocusTarget(1, 4, true)).toBeNull();
  expect(bulkMetadataDialogFocusTarget(-1, 4, false)).toBe(0);
  expect(bulkMetadataDialogFocusTarget(-1, 4, true)).toBe(3);
  expect(bulkMetadataDialogFocusTarget(0, 0, false)).toBeNull();
});
