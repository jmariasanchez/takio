import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH } from "@takio/library-contract";

import {
  SaveLibraryViewDialog,
  saveDialogFocusTarget,
  validateSavedLibraryViewName,
} from "./SaveLibraryViewDialog";

function render(
  overrides: Partial<Parameters<typeof SaveLibraryViewDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <SaveLibraryViewDialog
      open
      suggestedName="Science fiction"
      busy={false}
      error={null}
      onCancel={() => undefined}
      onSave={() => undefined}
      {...overrides}
    />,
  );
}

test("renders a labelled modal form with the suggested name", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
  const inputId = markup.match(/<label for="([^"]+)">Virtual library name<\/label>/)?.[1];

  expect(titleId).toBeDefined();
  expect(inputId).toBeDefined();
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Save virtual library</h2>`);
  expect(markup).toContain(`<input id="${inputId}" type="text"`);
  expect(markup).toContain('name="saved-library-view-name"');
  expect(markup).toContain(`maxLength="${MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH}"`);
  expect(markup).toContain('value="Science fiction"');
  expect(markup).toContain('<button type="submit">Save virtual library</button>');
});

test("does not render dialog controls while closed", () => {
  expect(render({ open: false })).toBe("");
});

test("shows external errors inline and exposes busy state", () => {
  const markup = render({ busy: true, error: "That name is already in use." });
  const errorId = markup.match(/aria-describedby="([^"]+)"/)?.[1];

  expect(errorId).toBeDefined();
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('disabled="" aria-invalid="true"');
  expect(markup).toContain(`<p class="save-library-view-dialog__error" id="${errorId}" role="alert">`);
  expect(markup).toContain("That name is already in use.");
  expect(markup).toContain('<button type="submit" disabled="">Saving…</button>');
  expect(markup).toContain('<button type="button">Cancel</button>');
});

test("wraps modal focus at both boundaries and handles an empty control set", () => {
  expect(saveDialogFocusTarget(0, 3, true)).toBe(2);
  expect(saveDialogFocusTarget(2, 3, false)).toBe(0);
  expect(saveDialogFocusTarget(1, 3, true)).toBeNull();
  expect(saveDialogFocusTarget(1, 3, false)).toBeNull();
  expect(saveDialogFocusTarget(-1, 3, true)).toBe(2);
  expect(saveDialogFocusTarget(-1, 3, false)).toBe(0);
  expect(saveDialogFocusTarget(0, 0, true)).toBeNull();
  expect(saveDialogFocusTarget(0, 0, false)).toBeNull();
});

test("validates exactly the contract name rule and returns the trimmed value", () => {
  expect(validateSavedLibraryViewName("")).toEqual({
    name: null,
    error: "Enter a name for this virtual library.",
  });
  expect(validateSavedLibraryViewName("  \n\t ")).toEqual({
    name: null,
    error: "Enter a name for this virtual library.",
  });
  expect(validateSavedLibraryViewName("  Recent EPUBs  ")).toEqual({
    name: "Recent EPUBs",
    error: null,
  });
  expect(
    validateSavedLibraryViewName("x".repeat(MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH)),
  ).toEqual({
    name: "x".repeat(MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH),
    error: null,
  });
  expect(
    validateSavedLibraryViewName("x".repeat(MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH + 1)),
  ).toEqual({
    name: null,
    error: `Use ${MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH} characters or fewer.`,
  });
});
