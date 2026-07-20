import { describe, expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import {
  queryLibraryItemsRequestSchema,
  type LibraryFacetCounts,
  type LibraryQueryPage,
  type SavedLibraryViewDefinition,
} from "@takio/library-contract";

import {
  DEFAULT_LIBRARY_QUERY_REQUEST,
  applyLibraryQueryResponse,
  boundedLibraryPageOffset,
  createLibraryQueryState,
  issueLibraryQueryRequest,
  libraryQueryStateReducer,
} from "./library-query-state";

const emptyFacets: LibraryFacetCounts = {
  authors: [],
  tags: [],
  series: [],
  languages: [],
  formats: [],
};

function item(id: string): LibraryItem {
  return {
    id,
    title: `Book ${id}`,
    sourcePath: `/library/${id}.epub`,
    format: "epub",
    addedAt: "2026-07-20T12:00:00.000Z",
    formats: [
      {
        sourcePath: `/library/${id}.epub`,
        format: "epub",
        addedAt: "2026-07-20T12:00:00.000Z",
        provenance: "managed",
      },
    ],
    tags: [],
  };
}

function page(
  items: readonly LibraryItem[],
  total: number,
  offset = 0,
  limit = 25,
): LibraryQueryPage {
  return { items, total, page: { offset, limit }, facets: emptyFacets };
}

describe("library query state", () => {
  test("starts from one valid, bounded catalogue request so every caller shares the same baseline", () => {
    const state = createLibraryQueryState();

    expect(queryLibraryItemsRequestSchema.parse(DEFAULT_LIBRARY_QUERY_REQUEST)).toEqual({
      query: "",
      filters: {
        authors: [],
        tags: [],
        series: [],
        languages: [],
        formats: [],
      },
      sort: { field: "title", direction: "ascending" },
      page: { offset: 0, limit: 25 },
    });
    expect(state).toMatchObject({
      request: DEFAULT_LIBRARY_QUERY_REQUEST,
      page: null,
      selectedItemId: null,
      lastIssuedRequestToken: 0,
      pendingRequestToken: null,
    });
  });

  test("resets paging when the result set changes but preserves explicit page navigation", () => {
    let state = createLibraryQueryState({
      ...DEFAULT_LIBRARY_QUERY_REQUEST,
      page: { offset: 50, limit: 25 },
    });

    state = libraryQueryStateReducer(state, { type: "set-query", query: "earthsea" });
    expect(state.request.page).toEqual({ offset: 0, limit: 25 });

    state = libraryQueryStateReducer(state, {
      type: "set-page",
      page: { offset: 25, limit: 25 },
    });
    expect(state.request.page).toEqual({ offset: 25, limit: 25 });

    state = libraryQueryStateReducer(state, {
      type: "set-filters",
      filters: { ...state.request.filters, authors: ["Ursula K. Le Guin"] },
    });
    expect(state.request.page.offset).toBe(0);

    state = libraryQueryStateReducer(state, {
      type: "set-page",
      page: { offset: 25, limit: 25 },
    });
    state = libraryQueryStateReducer(state, {
      type: "set-sort",
      sort: { field: "author", direction: "descending" },
    });
    expect(state.request.page.offset).toBe(0);
    expect(state.request.sort).toEqual({ field: "author", direction: "descending" });
  });

  test("applies a saved definition as a new result set without letting views persist session paging", () => {
    const definition: SavedLibraryViewDefinition = {
      version: 1,
      query: "classic",
      filters: {
        authors: [],
        tags: ["Classic"],
        series: [],
        languages: ["en"],
        formats: ["epub"],
      },
      sort: { field: "addedAt", direction: "descending" },
    };
    const state = libraryQueryStateReducer(
      createLibraryQueryState({
        ...DEFAULT_LIBRARY_QUERY_REQUEST,
        page: { offset: 75, limit: 25 },
      }),
      { type: "apply-saved-view", definition },
    );

    expect(state.request).toEqual({
      query: definition.query,
      filters: definition.filters,
      sort: definition.sort,
      page: { offset: 0, limit: 25 },
    });
  });

  test("invalidates pending work as soon as request intent changes so an old response cannot win the effect race", () => {
    const first = issueLibraryQueryRequest(createLibraryQueryState());
    const changed = libraryQueryStateReducer(first.state, {
      type: "set-query",
      query: "new query",
    });

    expect(changed.pendingRequestToken).toBeNull();
    expect(
      applyLibraryQueryResponse(changed, first.request.token, page([item("old")], 1)),
    ).toBe(changed);

    const second = issueLibraryQueryRequest(changed);
    expect(second.request.token).toBeGreaterThan(first.request.token);
    expect(second.request.request.query).toBe("new query");
  });

  test("invalidates the committed page when request intent changes so old rows cannot describe a new query", () => {
    const issued = issueLibraryQueryRequest(createLibraryQueryState());
    const loaded = applyLibraryQueryResponse(
      issued.state,
      issued.request.token,
      page([item("old-result")], 1),
    );
    const changed = libraryQueryStateReducer(loaded, {
      type: "set-query",
      query: "a different catalogue",
    });

    expect(loaded.page?.items.map(({ id }) => id)).toEqual(["old-result"]);
    expect(changed.request.query).toBe("a different catalogue");
    expect(changed.page).toBeNull();
  });

  test("accepts only the latest issued token because slower requests must not replace fresher catalogue data", () => {
    const first = issueLibraryQueryRequest(createLibraryQueryState());
    const second = issueLibraryQueryRequest(first.state);
    const stale = applyLibraryQueryResponse(
      second.state,
      first.request.token,
      page([item("stale")], 1),
    );
    const fresh = applyLibraryQueryResponse(
      stale,
      second.request.token,
      page([item("fresh")], 100),
    );

    expect(stale).toBe(second.state);
    expect(fresh.page?.items.map(({ id }) => id)).toEqual(["fresh"]);
    expect(fresh.request.page.offset).toBe(0);
    expect(fresh.pendingRequestToken).toBeNull();

    const third = issueLibraryQueryRequest(fresh);
    expect(third.request.token).toBe(second.request.token + 1);
  });

  test("reconciles an out-of-range offset after deletions so the next request targets the last real page", () => {
    const issued = issueLibraryQueryRequest(
      createLibraryQueryState({
        ...DEFAULT_LIBRARY_QUERY_REQUEST,
        page: { offset: 50, limit: 25 },
      }),
    );
    const reconciled = applyLibraryQueryResponse(
      issued.state,
      issued.request.token,
      page([], 31, 50, 25),
    );

    expect(boundedLibraryPageOffset(50, 31, 25)).toBe(25);
    expect(boundedLibraryPageOffset(50, 0, 25)).toBe(0);
    expect(reconciled.request.page).toEqual({ offset: 25, limit: 25 });
    expect(reconciled.page).toBeNull();
    expect(reconciled.pendingRequestToken).toBeNull();

    const retry = issueLibraryQueryRequest(reconciled);
    expect(retry.request.request.page.offset).toBe(25);
    expect(retry.request.token).toBe(issued.request.token + 1);
  });

  test("keeps selection only while it remains visible, then chooses a usable first row or null", () => {
    const initial = issueLibraryQueryRequest(createLibraryQueryState());
    let state = applyLibraryQueryResponse(
      initial.state,
      initial.request.token,
      page([item("one"), item("two")], 2),
    );
    expect(state.selectedItemId).toBe("one");

    state = libraryQueryStateReducer(state, { type: "select-item", id: "two" });
    const refresh = issueLibraryQueryRequest(state);
    state = applyLibraryQueryResponse(
      refresh.state,
      refresh.request.token,
      page([item("one"), item("two")], 2),
    );
    expect(state.selectedItemId).toBe("two");

    const replacement = issueLibraryQueryRequest(state);
    state = applyLibraryQueryResponse(
      replacement.state,
      replacement.request.token,
      page([item("three")], 1),
    );
    expect(state.selectedItemId).toBe("three");

    const empty = issueLibraryQueryRequest(state);
    state = applyLibraryQueryResponse(empty.state, empty.request.token, page([], 0));
    expect(state.selectedItemId).toBeNull();
  });
});
