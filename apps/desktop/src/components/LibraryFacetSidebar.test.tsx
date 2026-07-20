import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  LibraryFacetCounts,
  LibraryQueryFilters,
  SavedLibraryView,
} from "@takio/library-contract";

import {
  LibraryFacetSidebar,
  type LibraryFacetSidebarProps,
} from "./LibraryFacetSidebar";

type InteractiveElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly "aria-pressed"?: boolean;
  readonly checked?: boolean;
  readonly children?: ReactNode;
  readonly onChange?: () => void;
  readonly onClick?: () => void;
}>;

function elements(node: ReactNode): InteractiveElement[] {
  if (!isValidElement(node)) {
    return [];
  }
  const element = node as InteractiveElement;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}

const facets: LibraryFacetCounts = {
  authors: [
    { value: "Octavia E. Butler", count: 4 },
    { value: "Ursula K. Le Guin", count: 7 },
  ],
  tags: [{ value: "Classic", count: 12 }],
  series: [{ value: "Hainish", count: 3 }],
  languages: [{ value: "en", count: 9 }],
  formats: [{ value: "epub", count: 8 }],
};

const filters: LibraryQueryFilters = {
  authors: ["Ursula K. Le Guin"],
  tags: ["Classic"],
  series: [],
  languages: [],
  formats: [],
};

const savedViews: readonly SavedLibraryView[] = [
  {
    id: "favourites",
    name: "Favourites",
    definition: {
      version: 1,
      query: "",
      filters,
      sort: { field: "rating", direction: "descending" },
    },
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  },
  {
    id: "unread",
    name: "Unread",
    definition: {
      version: 1,
      query: "",
      filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
      sort: { field: "addedAt", direction: "descending" },
    },
    createdAt: "2026-07-20T12:01:00.000Z",
    updatedAt: "2026-07-20T12:01:00.000Z",
  },
];

function props(overrides: Partial<LibraryFacetSidebarProps> = {}): LibraryFacetSidebarProps {
  return {
    facets,
    filters,
    savedViews,
    currentSavedViewId: "favourites",
    onChangeFilters: () => undefined,
    onClearAll: () => undefined,
    onApplySavedView: () => undefined,
    onSaveSavedView: () => undefined,
    onRemoveSavedView: () => undefined,
    ...overrides,
  };
}

test("renders authoritative counts for every supplied facet and accessible multi-selection", () => {
  const tree = LibraryFacetSidebar(props());
  const markup = renderToStaticMarkup(tree);
  const controls = elements(tree);

  expect(markup).toContain('aria-label="Library filters and saved views"');
  for (const heading of ["Authors", "Tags", "Series", "Languages", "Formats"]) {
    expect(markup).toContain(`>${heading}</h2>`);
  }
  expect(markup).toContain('aria-label="Ursula K. Le Guin, 7 books"');
  expect(markup).toContain('aria-label="Classic, 12 books"');
  expect(markup).toContain('aria-label="Hainish, 3 books"');
  expect(markup).toContain('aria-label="en, 9 books"');
  expect(markup).toContain('aria-label="EPUB, 8 books"');
  expect(
    controls
      .filter((element) => element.type === "input" && element.props.checked)
      .map((element) => element.props["aria-label"]),
  ).toEqual(["Ursula K. Le Guin, 7 books", "Classic, 12 books"]);
});

test("facet checkboxes emit exact complete filters for OR-within toggles", () => {
  const changes: LibraryQueryFilters[] = [];
  const tree = LibraryFacetSidebar(
    props({ onChangeFilters: (nextFilters) => changes.push(nextFilters) }),
  );
  const controls = elements(tree);

  controls
    .find((element) => element.props["aria-label"] === "Octavia E. Butler, 4 books")
    ?.props.onChange?.();
  controls
    .find((element) => element.props["aria-label"] === "Ursula K. Le Guin, 7 books")
    ?.props.onChange?.();

  expect(changes).toEqual([
    {
      authors: ["Ursula K. Le Guin", "Octavia E. Butler"],
      tags: ["Classic"],
      series: [],
      languages: [],
      formats: [],
    },
    {
      authors: [],
      tags: ["Classic"],
      series: [],
      languages: [],
      formats: [],
    },
  ]);
});

test("All books and saved-view controls emit exact controlled actions", () => {
  const actions: string[] = [];
  const tree = LibraryFacetSidebar(
    props({
      onClearAll: () => actions.push("clear"),
      onApplySavedView: (id) => actions.push(`apply:${id}`),
      onSaveSavedView: () => actions.push("save"),
      onRemoveSavedView: (id) => actions.push(`remove:${id}`),
    }),
  );
  const controls = elements(tree);

  const buttons = controls.filter((element) => element.type === "button");
  buttons
    .find((element) => element.props["aria-label"] === "All books, clear current query")
    ?.props.onClick?.();
  buttons.find((element) => element.props.children === "Save current")?.props.onClick?.();
  buttons.find((element) => element.props.children === "Unread")?.props.onClick?.();
  buttons
    .find((element) => element.props["aria-label"] === "Remove saved view Favourites")
    ?.props.onClick?.();

  expect(actions).toEqual(["clear", "save", "apply:unread", "remove:favourites"]);
  expect(
    buttons.find((element) => element.props.children === "Favourites")?.props["aria-pressed"],
  ).toBe(true);
  expect(buttons.find((element) => element.props.children === "Unread")?.props["aria-pressed"]).toBe(
    false,
  );
});

test("omits empty facet groups and does not fabricate library categories", () => {
  const markup = renderToStaticMarkup(
    <LibraryFacetSidebar
      {...props({
        facets: { authors: [], tags: [], series: [], languages: [], formats: [] },
        savedViews: [],
        currentSavedViewId: null,
      })}
    />,
  );

  expect(markup).toContain("All books");
  expect(markup).toContain("No saved views");
  for (const absent of [
    "Authors",
    "Tags",
    "Series",
    "Languages",
    "Formats",
    "Recently added",
    "Favourites",
  ]) {
    expect(markup).not.toContain(`>${absent}<`);
  }
});
