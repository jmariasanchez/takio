import { expect, test } from "bun:test";

import { hasOpenLibraryModal } from "./App";

const closedDialogs = {
  saveView: false,
  import: false,
  trash: false,
  duplicateReview: false,
  bulkTags: false,
  bulkMetadata: false,
  bulkExport: false,
};

test("blocks background entry points while the export dialog owns focus", () => {
  expect(hasOpenLibraryModal(closedDialogs)).toBe(false);
  expect(hasOpenLibraryModal({ ...closedDialogs, bulkExport: true })).toBe(true);
});
