export type LibraryPageSelectionState = "none" | "some" | "all";

export type LibrarySelectionState = {
  readonly activeItemId: string | null;
  readonly selectedItemIds: readonly string[];
  readonly rangeAnchorItemId: string | null;
};

export type LibrarySelectionAction =
  | { readonly type: "set-active-item"; readonly id: string | null }
  | { readonly type: "toggle-item"; readonly id: string }
  | {
      readonly type: "select-range";
      readonly id: string;
      readonly pageItemIds: readonly string[];
    }
  | { readonly type: "toggle-page"; readonly pageItemIds: readonly string[] }
  | { readonly type: "clear-selection" }
  | { readonly type: "page-changed" }
  | { readonly type: "sort-changed" }
  | { readonly type: "query-changed" };

export function createLibrarySelectionState(
  activeItemId: string | null = null,
): LibrarySelectionState {
  return {
    activeItemId,
    selectedItemIds: [],
    rangeAnchorItemId: null,
  };
}

function uniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)];
}

function addSelectedIds(
  selectedItemIds: readonly string[],
  ids: readonly string[],
): readonly string[] {
  const selected = new Set(selectedItemIds);
  const next = [...selectedItemIds];

  for (const id of ids) {
    if (!selected.has(id)) {
      selected.add(id);
      next.push(id);
    }
  }

  return next;
}

export function libraryPageSelectionState(
  selectedItemIds: readonly string[],
  pageItemIds: readonly string[],
): LibraryPageSelectionState {
  const pageIds = uniqueIds(pageItemIds);
  if (pageIds.length === 0) {
    return "none";
  }

  const selected = new Set(selectedItemIds);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  if (selectedOnPage === 0) {
    return "none";
  }
  return selectedOnPage === pageIds.length ? "all" : "some";
}

export function librarySelectionReducer(
  state: LibrarySelectionState,
  action: LibrarySelectionAction,
): LibrarySelectionState {
  switch (action.type) {
    case "set-active-item":
      return action.id === state.activeItemId
        ? state
        : { ...state, activeItemId: action.id };
    case "toggle-item": {
      const isSelected = state.selectedItemIds.includes(action.id);
      return {
        ...state,
        activeItemId: action.id,
        selectedItemIds: isSelected
          ? state.selectedItemIds.filter((id) => id !== action.id)
          : [...state.selectedItemIds, action.id],
        rangeAnchorItemId: action.id,
      };
    }
    case "select-range": {
      const pageItemIds = uniqueIds(action.pageItemIds);
      const targetIndex = pageItemIds.indexOf(action.id);
      if (targetIndex === -1) {
        return state;
      }

      const anchorIndex =
        state.rangeAnchorItemId === null
          ? -1
          : pageItemIds.indexOf(state.rangeAnchorItemId);
      if (anchorIndex === -1) {
        return {
          ...state,
          activeItemId: action.id,
          selectedItemIds: addSelectedIds(state.selectedItemIds, [action.id]),
          rangeAnchorItemId: action.id,
        };
      }

      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return {
        ...state,
        activeItemId: action.id,
        selectedItemIds: addSelectedIds(
          state.selectedItemIds,
          pageItemIds.slice(start, end + 1),
        ),
      };
    }
    case "toggle-page": {
      const pageItemIds = uniqueIds(action.pageItemIds);
      if (pageItemIds.length === 0) {
        return state;
      }

      if (libraryPageSelectionState(state.selectedItemIds, pageItemIds) === "all") {
        const pageIds = new Set(pageItemIds);
        return {
          ...state,
          selectedItemIds: state.selectedItemIds.filter((id) => !pageIds.has(id)),
          rangeAnchorItemId: null,
        };
      }

      return {
        ...state,
        selectedItemIds: addSelectedIds(state.selectedItemIds, pageItemIds),
        rangeAnchorItemId: null,
      };
    }
    case "clear-selection":
      if (state.selectedItemIds.length === 0 && state.rangeAnchorItemId === null) {
        return state;
      }
      return { ...state, selectedItemIds: [], rangeAnchorItemId: null };
    case "page-changed":
    case "sort-changed":
      return state.rangeAnchorItemId === null
        ? state
        : { ...state, rangeAnchorItemId: null };
    case "query-changed":
      return createLibrarySelectionState();
  }
}
