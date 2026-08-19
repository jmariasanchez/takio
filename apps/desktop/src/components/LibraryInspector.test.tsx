import { expect, test } from "bun:test";
import type { BookFormat, LibraryItem } from "@takio/core";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryInspector } from "./LibraryInspector";

type ActionElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}>;

function actionElements(node: ReactNode): ActionElement[] {
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ActionElement;
  return [element, ...Children.toArray(element.props.children).flatMap(actionElements)];
}

const item = {
  id: "item-1",
  title: "The Left Hand of Darkness",
  sourcePath: "/Books/left-hand.epub",
  coverPath: "/Covers/left-hand.jpg",
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
  author: "Legacy author",
  authors: [
    { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
    { name: "A second contributor" },
  ],
  series: "Hainish Cycle",
  seriesIndex: 4.5,
  publisher: "Ace Books",
  languages: ["en-US", "fr"],
  identifiers: { isbn: "9780441478125", asin: "B00YBA7PGW" },
  publishedDate: "1969-03",
  rating: 8.5,
  description: "A novel of exile, identity, and trust.",
  tags: ["Science fiction", "Classic"],
} as const satisfies LibraryItem;

const convertibleItem = {
  ...item,
  sourcePath: "/Books/left-hand.mobi",
  format: "mobi",
  formats: [
    {
      sourcePath: "/Books/left-hand.mobi",
      format: "mobi",
      addedAt: "2026-07-18T12:00:00.000Z",
      provenance: "managed",
    },
    {
      sourcePath: "/Books/left-hand.epub",
      format: "epub",
      addedAt: "2026-07-19T12:00:00.000Z",
      provenance: "referenced",
    },
  ],
} as const satisfies LibraryItem;

test("renders selected metadata and every real format without a reading surface", () => {
  const markup = renderToStaticMarkup(
    <LibraryInspector
      item={item}
      onConvertFormat={() => undefined}
      onOpenFormat={() => undefined}
      onSendFormat={() => undefined}
    />,
  );

  expect(markup).toContain("The Left Hand of Darkness");
  expect(markup).toContain('alt="Cover of The Left Hand of Darkness"');
  expect(markup).toContain("takio-cover://local/%2FCovers%2Fleft-hand.jpg");
  expect(markup).toContain("Ursula K. Le Guin, A second contributor");
  expect(markup).not.toContain("Legacy author");
  expect(markup).toContain("Hainish Cycle");
  expect(markup).toContain("4.5");
  expect(markup).toContain("Ace Books");
  expect(markup).toContain("en-US, fr");
  expect(markup).toContain("ISBN: 9780441478125, ASIN: B00YBA7PGW");
  expect(markup).toContain("1969-03");
  expect(markup).toContain("8.5 / 10");
  expect(markup).toContain("Science fiction, Classic");
  expect(markup).toContain("A novel of exile, identity, and trust.");
  expect(markup).toContain("EPUB");
  expect(markup).toContain("PDF");
  expect(markup).toContain("2 owned");
  expect(markup).toContain("Managed copy");
  expect(markup).toContain("Linked file");
  expect(markup).toContain("Added");
  expect(markup).toContain("Technical details");
  expect(markup).toContain("Source path");
  expect(markup).toContain("/Books/left-hand.pdf");
  expect(markup).not.toContain("Convert PDF");
  expect(markup).not.toContain("Convert EPUB");
  expect(markup).not.toContain("Reader");
});

test("renders a fallback monogram when the selected book has no cover", () => {
  const markup = renderToStaticMarkup(
    <LibraryInspector
      item={{ ...item, coverPath: undefined }}
      onConvertFormat={() => undefined}
      onOpenFormat={() => undefined}
      onSendFormat={() => undefined}
    />,
  );

  expect(markup).toContain("library-inspector__cover--fallback");
  expect(markup).toContain(">T</span>");
  expect(markup).not.toContain("takio-cover://local/");
});

test("open and send buttons emit the selected item and exact format object", () => {
  const calls: Array<{
    action: "open" | "send";
    book: LibraryItem;
    bookFormat: BookFormat;
  }> = [];
  const tree = LibraryInspector({
    item,
    onConvertFormat: () => undefined,
    onOpenFormat: (book, bookFormat) => calls.push({ action: "open", book, bookFormat }),
    onSendFormat: (book, bookFormat) => calls.push({ action: "send", book, bookFormat }),
  });
  const actions = actionElements(tree);

  for (const [label, action] of [
    ["Open PDF for The Left Hand of Darkness", "open"],
    ["Send PDF for The Left Hand of Darkness", "send"],
  ] as const) {
    const button = actions.find((element) => element.props["aria-label"] === label);
    expect(button).toBeDefined();
    button?.props.onClick?.();
    expect(calls.at(-1)).toEqual({ action, book: item, bookFormat: item.formats[1] });
  }
});

test("conversion emits the exact secondary EPUB choice and never offers PDF as a source", () => {
  const calls: Array<{
    book: LibraryItem;
    source: BookFormat;
    target: string;
  }> = [];
  const tree = LibraryInspector({
    item: convertibleItem,
    onConvertFormat: (book, choice) =>
      calls.push({ book, source: choice.source, target: choice.target }),
    onOpenFormat: () => undefined,
    onSendFormat: () => undefined,
  });
  const actions = actionElements(tree);
  const conversionButton = actions.find(
    (element) =>
      element.props["aria-label"] ===
      "Convert EPUB to PDF for The Left Hand of Darkness",
  );

  expect(conversionButton).toBeDefined();
  expect(
    actions.find((element) => element.props["aria-label"]?.startsWith("Convert MOBI")),
  ).toBeUndefined();
  conversionButton?.props.onClick?.();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.book).toBe(convertibleItem);
  expect(calls[0]?.source).toBe(convertibleItem.formats[1]);
  expect(calls[0]?.target).toBe("pdf");
});

test("renders a concise inspector empty state when selection is absent", () => {
  const markup = renderToStaticMarkup(
    <LibraryInspector
      item={null}
      onConvertFormat={() => undefined}
      onOpenFormat={() => undefined}
      onSendFormat={() => undefined}
    />,
  );

  expect(markup).toContain("No book selected");
  expect(markup).not.toContain("<button");
});
