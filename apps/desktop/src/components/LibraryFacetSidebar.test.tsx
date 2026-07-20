import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryFacetSidebar } from "./LibraryFacetSidebar";

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

const groups = [
  {
    id: "library",
    label: "Library",
    views: [
      { id: "all", label: "All books", count: 2482 },
      { id: "recent", label: "Recently added", count: 31 },
    ],
  },
  {
    id: "formats",
    label: "Formats",
    views: [{ id: "format:epub", label: "EPUB", count: 1420 }],
  },
] as const;

test("renders only supplied facet groups, labels, and counts", () => {
  const markup = renderToStaticMarkup(
    <LibraryFacetSidebar
      groups={groups}
      selectedViewId="all"
      onSelectView={() => undefined}
    />,
  );

  expect(markup).toContain('aria-label="Library views"');
  expect(markup).toContain("All books");
  expect(markup).toContain("Recently added");
  expect(markup).toContain("Formats");
  expect(markup).toContain("2,482");
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).not.toContain("Authors");
  expect(markup).not.toContain("Tags");
});

test("selected view buttons emit their exact supplied ID", () => {
  const selections: string[] = [];
  const tree = LibraryFacetSidebar({
    groups,
    selectedViewId: "all",
    onSelectView: (id) => selections.push(id),
  });
  const epubButton = actionElements(tree).find(
    (element) => element.props["aria-label"] === "EPUB, 1420 books",
  );

  expect(epubButton).toBeDefined();
  epubButton?.props.onClick?.();
  expect(selections).toEqual(["format:epub"]);
});
