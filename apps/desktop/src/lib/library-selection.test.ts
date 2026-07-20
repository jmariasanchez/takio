import { describe, expect, test } from "bun:test";

import {
  createLibrarySelectionState,
  libraryPageSelectionState,
  librarySelectionReducer,
  type LibrarySelectionState,
} from "./library-selection";

function selectedState(
  selectedItemIds: readonly string[],
  activeItemId = "book-2",
  rangeAnchorItemId: string | null = "book-2",
): LibrarySelectionState {
  return { activeItemId, selectedItemIds, rangeAnchorItemId };
}

describe("library selection", () => {
  test("starts without an implicit bulk selection because the active inspector item is independent", () => {
    expect(createLibrarySelectionState("book-1")).toEqual({
      activeItemId: "book-1",
      selectedItemIds: [],
      rangeAnchorItemId: null,
    });
  });

  test("moves the active row without selecting it or replacing an existing range anchor", () => {
    const state = selectedState(["book-2"]);

    expect(
      librarySelectionReducer(state, { type: "set-active-item", id: "book-3" }),
    ).toEqual({
      activeItemId: "book-3",
      selectedItemIds: ["book-2"],
      rangeAnchorItemId: "book-2",
    });
    expect(
      librarySelectionReducer(state, { type: "set-active-item", id: "book-2" }),
    ).toBe(state);
  });

  test("toggles one item deterministically and makes the interaction the next range anchor", () => {
    let state = createLibrarySelectionState("book-1");

    state = librarySelectionReducer(state, { type: "toggle-item", id: "book-2" });
    state = librarySelectionReducer(state, { type: "toggle-item", id: "book-3" });
    expect(state).toEqual({
      activeItemId: "book-3",
      selectedItemIds: ["book-2", "book-3"],
      rangeAnchorItemId: "book-3",
    });

    expect(
      librarySelectionReducer(state, { type: "toggle-item", id: "book-2" }),
    ).toEqual({
      activeItemId: "book-2",
      selectedItemIds: ["book-3"],
      rangeAnchorItemId: "book-2",
    });
  });

  test("adds inclusive ranges in either direction without disturbing selections from other pages", () => {
    const pageItemIds = ["book-1", "book-2", "book-3", "book-4"];
    const initial = selectedState(["book-2", "other-page"]);

    const forwards = librarySelectionReducer(initial, {
      type: "select-range",
      id: "book-4",
      pageItemIds,
    });
    expect(forwards).toEqual({
      activeItemId: "book-4",
      selectedItemIds: ["book-2", "other-page", "book-3", "book-4"],
      rangeAnchorItemId: "book-2",
    });

    const backwards = librarySelectionReducer(
      selectedState(["book-4", "other-page"], "book-4", "book-4"),
      { type: "select-range", id: "book-2", pageItemIds },
    );
    expect(backwards).toEqual({
      activeItemId: "book-2",
      selectedItemIds: ["book-4", "other-page", "book-2", "book-3"],
      rangeAnchorItemId: "book-4",
    });
  });

  test("starts a new one-item range when the previous anchor is not on the supplied page", () => {
    const state = selectedState(["other-page"], "other-page", "other-page");

    expect(
      librarySelectionReducer(state, {
        type: "select-range",
        id: "book-2",
        pageItemIds: ["book-1", "book-2", "book-3"],
      }),
    ).toEqual({
      activeItemId: "book-2",
      selectedItemIds: ["other-page", "book-2"],
      rangeAnchorItemId: "book-2",
    });
  });

  test("rejects a range target outside the supplied page so unloaded rows are never inferred", () => {
    const state = selectedState(["book-1"], "book-1", "book-1");

    expect(
      librarySelectionReducer(state, {
        type: "select-range",
        id: "book-9",
        pageItemIds: ["book-1", "book-2"],
      }),
    ).toBe(state);
  });

  test("selects every missing page item, then removes only that page when all are selected", () => {
    const initial = selectedState(["book-2", "other-page"]);
    const selected = librarySelectionReducer(initial, {
      type: "toggle-page",
      pageItemIds: ["book-1", "book-2", "book-2", "book-3"],
    });

    expect(selected).toEqual({
      activeItemId: "book-2",
      selectedItemIds: ["book-2", "other-page", "book-1", "book-3"],
      rangeAnchorItemId: null,
    });
    expect(
      librarySelectionReducer(selected, {
        type: "toggle-page",
        pageItemIds: ["book-1", "book-2", "book-3"],
      }),
    ).toEqual({
      activeItemId: "book-2",
      selectedItemIds: ["other-page"],
      rangeAnchorItemId: null,
    });
  });

  test("reports page checkbox state from unique current-page IDs", () => {
    expect(libraryPageSelectionState(["other-page"], [])).toBe("none");
    expect(
      libraryPageSelectionState(["other-page"], ["book-1", "book-2"]),
    ).toBe("none");
    expect(
      libraryPageSelectionState(["book-1"], ["book-1", "book-2", "book-2"]),
    ).toBe("some");
    expect(
      libraryPageSelectionState(
        ["book-1", "book-2", "other-page"],
        ["book-1", "book-2", "book-2"],
      ),
    ).toBe("all");
  });

  test("retains explicit selections across pages and sorts but clears page-order anchors", () => {
    const state = selectedState(["book-1", "other-page"]);

    expect(librarySelectionReducer(state, { type: "page-changed" })).toEqual({
      ...state,
      rangeAnchorItemId: null,
    });
    expect(librarySelectionReducer(state, { type: "sort-changed" })).toEqual({
      ...state,
      rangeAnchorItemId: null,
    });
  });

  test("clears active and selected IDs when a query changes because they describe another result set", () => {
    expect(
      librarySelectionReducer(selectedState(["book-1", "book-2"]), {
        type: "query-changed",
      }),
    ).toEqual(createLibrarySelectionState());
  });

  test("clears bulk selection without closing the active book inspector", () => {
    expect(
      librarySelectionReducer(selectedState(["book-1", "book-2"]), {
        type: "clear-selection",
      }),
    ).toEqual({
      activeItemId: "book-2",
      selectedItemIds: [],
      rangeAnchorItemId: null,
    });
  });

  test("removes only completed bulk targets while retaining failures and the active inspector item", () => {
    const state = selectedState(
      ["completed", "failed", "missing", "other-page"],
      "completed",
      "completed",
    );

    expect(
      librarySelectionReducer(state, {
        type: "remove-items",
        ids: ["completed", "missing", "missing", "not-selected"],
      }),
    ).toEqual({
      activeItemId: "completed",
      selectedItemIds: ["failed", "other-page"],
      rangeAnchorItemId: null,
    });
  });

  test("preserves selection identity when a selective removal has no selected targets", () => {
    const state = selectedState(["failed"]);

    expect(
      librarySelectionReducer(state, { type: "remove-items", ids: [] }),
    ).toBe(state);
    expect(
      librarySelectionReducer(state, {
        type: "remove-items",
        ids: ["not-selected"],
      }),
    ).toBe(state);
  });
});
