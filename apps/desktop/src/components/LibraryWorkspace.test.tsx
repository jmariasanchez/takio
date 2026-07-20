import { expect, test } from "bun:test";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { BookFormat, LibraryItem } from "@takio/core";

import {
  LibraryWorkspace,
  resolveGeneralSend,
  type ConversionDraft,
} from "./LibraryWorkspace";

type ButtonElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: (event: { stopPropagation: () => void }) => void;
}>;

function buttonElements(node: ReactNode): ButtonElement[] {
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ButtonElement;
  const descendants = Children.toArray(element.props.children).flatMap(buttonElements);
  return element.type === "button" ? [element, ...descendants] : descendants;
}

const epub = {
  format: "epub",
  sourcePath: "/Books/Title.epub",
  provenance: "managed",
  addedAt: "2026-07-20T12:00:00.000Z",
} as const satisfies BookFormat;

const pdf = {
  format: "pdf",
  sourcePath: "/Books/Title.pdf",
  provenance: "managed",
  addedAt: "2026-07-20T12:01:00.000Z",
} as const satisfies BookFormat;

const destination = {
  id: "reader",
  name: "Reader",
  path: "/Volumes/Reader",
  kind: "generic",
} as const;

function workspace(
  formats: readonly BookFormat[],
  preferredDeviceFormat: BookFormat["format"] | null,
  onSendItem: (item: LibraryItem, format: BookFormat) => Promise<void>,
  onSetConversionDraft: (draft: ConversionDraft | null) => void,
): ReactNode {
  const item: LibraryItem = {
    id: "item-1",
    title: "Title",
    sourcePath: formats[0].sourcePath,
    format: formats[0].format,
    formats,
    addedAt: "2026-07-20T12:00:00.000Z",
    tags: [],
  };

  return LibraryWorkspace({
    actionsPending: false,
    conversionDraft: null,
    draft: null,
    items: [item],
    libraryState: "ready",
    pendingAction: null,
    preferredDeviceFormat,
    query: "",
    searchInput: { current: null },
    searchPending: false,
    selectedDestination: destination,
    selectedItemId: item.id,
    onAttachFormat: async () => undefined,
    onChangeSearch: () => undefined,
    onChooseCover: async () => undefined,
    onClearCover: async () => undefined,
    onEnqueueConversion: async () => undefined,
    onOpenItem: async () => undefined,
    onRemoveFormat: async () => undefined,
    onRemoveItem: async () => undefined,
    onRetry: async () => true,
    onSaveMetadata: async () => undefined,
    onSelectItem: () => undefined,
    onSendItem,
    onSetConversionDraft,
    onSetDraft: () => undefined,
  });
}

test("general Send uses the exact preferred attachment rather than the primary format", () => {
  const sentFormats: BookFormat[] = [];
  const tree = workspace(
    [epub, pdf],
    "pdf",
    async (_item, format) => {
      sentFormats.push(format);
    },
    () => undefined,
  );
  const send = buttonElements(tree).find(
    (button) => button.props["aria-label"] === "Send PDF for “Title” to Reader",
  );

  expect(send?.props.disabled).toBe(false);
  send?.props.onClick?.({ stopPropagation: () => undefined });
  expect(sentFormats).toEqual([pdf]);
});

test("shared row and menu resolution requires a preference and never falls back", () => {
  expect(resolveGeneralSend([epub, pdf], null)).toEqual({ kind: "no-preference" });
  expect(resolveGeneralSend([epub, pdf], "pdf")).toEqual({
    kind: "attached",
    bookFormat: pdf,
  });
  expect(resolveGeneralSend([epub], "pdf")).toEqual({
    kind: "convertible",
    source: epub,
    target: "pdf",
  });
  expect(resolveGeneralSend([epub], "azw3")).toEqual({
    kind: "unavailable",
    preferred: "azw3",
  });
});

test("general Send opens the exact conversion draft without sending", () => {
  const sentFormats: BookFormat[] = [];
  const drafts: Array<ConversionDraft | null> = [];
  const tree = workspace(
    [epub],
    "pdf",
    async (_item, format) => {
      sentFormats.push(format);
    },
    (draft) => drafts.push(draft),
  );
  const convert = buttonElements(tree).find((button) =>
    button.props["aria-label"]?.startsWith("Convert EPUB to PDF for “Title” before sending"),
  );

  expect(convert?.props.disabled).toBe(false);
  convert?.props.onClick?.({ stopPropagation: () => undefined });
  expect(sentFormats).toEqual([]);
  expect(drafts).toEqual([{ id: "item-1", source: epub, target: "pdf" }]);
});

test("general Send is disabled instead of falling back when preference is unavailable", () => {
  const tree = workspace([epub], "azw3", async () => undefined, () => undefined);
  const unavailable = buttonElements(tree).find(
    (button) => button.props["aria-label"] === "AZW3 is unavailable for “Title”",
  );

  expect(unavailable?.props.disabled).toBe(true);
  expect(unavailable?.props.children).toBe("AZW3 unavailable");
});

test("no preference disables general Send while exact per-format Send remains available", () => {
  const sentFormats: BookFormat[] = [];
  const tree = workspace(
    [epub],
    null,
    async (_item, format) => {
      sentFormats.push(format);
    },
    () => undefined,
  );
  const buttons = buttonElements(tree);
  const generalSend = buttons.find(
    (button) => button.props["aria-label"] === "Choose a session send format for “Title”",
  );
  const exactSend = buttons.find(
    (button) => button.props["aria-label"] === "Send EPUB for “Title” to Reader",
  );

  expect(generalSend?.props.disabled).toBe(true);
  expect(generalSend?.props.children).toBe("Choose format");
  expect(exactSend?.props.disabled).toBe(false);
  exactSend?.props.onClick?.({ stopPropagation: () => undefined });
  expect(sentFormats).toEqual([epub]);
});
