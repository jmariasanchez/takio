import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryExportDialog,
  exportDialogFocusTarget,
} from "./LibraryExportDialog";

test("renders an accessible filename choice for the snapshotted selection", () => {
  const markup = renderToStaticMarkup(
    <LibraryExportDialog
      open
      selectedCount={3}
      pending={false}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );

  expect(markup).toContain('role="dialog"');
  expect(markup).toContain('aria-modal="true"');
  expect(markup).toContain("3 books");
  expect(markup).toMatch(/checked="" value="title"/);
  expect(markup).toContain('value="author-title"');
  expect(markup).toContain("Choose folder…");
  expect(markup).toContain("stable suffix");
});

test("stays absent while closed and disables changes while pending", () => {
  expect(
    renderToStaticMarkup(
      <LibraryExportDialog
        open={false}
        selectedCount={1}
        pending={false}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    ),
  ).toBe("");

  const pending = renderToStaticMarkup(
    <LibraryExportDialog
      open
      selectedCount={1}
      pending
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  expect(pending).toContain('aria-busy="true"');
  expect(pending).toContain("Preparing…");
  expect(pending).toContain('fieldset disabled=""');
});

test("wraps keyboard focus inside the modal", () => {
  expect(exportDialogFocusTarget(0, 4, true)).toBe(3);
  expect(exportDialogFocusTarget(3, 4, false)).toBe(0);
  expect(exportDialogFocusTarget(1, 4, false)).toBeNull();
  expect(exportDialogFocusTarget(-1, 0, false)).toBeNull();
});
