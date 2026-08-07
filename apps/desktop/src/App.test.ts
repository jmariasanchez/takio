import { expect, test } from "bun:test";

import { dispatchLibraryMenuAction, hasOpenLibraryModal } from "./App";

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

  const calls: string[] = [];
  const handlers = {
    libraryModalOpen: true,
    openImport: () => calls.push("import"),
    importPaths: async () => undefined,
    openSelected: async () => {
      calls.push("open-selected");
    },
    sendSelected: async () => {
      calls.push("send-selected");
    },
    ejectSelected: async () => {
      calls.push("eject-selected");
    },
    find: () => calls.push("find"),
  };

  for (const action of ["import", "open-selected", "send-selected", "eject-selected", "find"]) {
    dispatchLibraryMenuAction(action, handlers);
  }

  expect(calls).toEqual([]);
});

test("dispatches supported native menu actions when no modal owns focus", () => {
  const calls: string[] = [];
  const handlers = {
    libraryModalOpen: false,
    openImport: () => calls.push("import"),
    importPaths: async () => undefined,
    openSelected: async () => {
      calls.push("open-selected");
    },
    sendSelected: async () => {
      calls.push("send-selected");
    },
    ejectSelected: async () => {
      calls.push("eject-selected");
    },
    find: () => calls.push("find"),
  };

  for (const action of ["import", "open-selected", "send-selected", "eject-selected", "find"]) {
    dispatchLibraryMenuAction(action, handlers);
  }

  expect(calls).toEqual(["import", "open-selected", "send-selected", "eject-selected", "find"]);
});
