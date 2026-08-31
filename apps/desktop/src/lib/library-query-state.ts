import {
  libraryQueryPageSchema,
  queryLibraryItemsRequestSchema,
  savedLibraryViewDefinitionSchema,
} from "@takio/library-contract";
import type {
  LibraryQueryFilters,
  LibraryQueryPage,
  LibraryQueryPageRequest,
  LibraryQuerySort,
  QueryLibraryItemsRequest,
  SavedLibraryViewDefinition,
} from "@takio/library-contract";

export const DEFAULT_LIBRARY_QUERY_REQUEST: QueryLibraryItemsRequest =
  queryLibraryItemsRequestSchema.parse({
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

export type LibraryQueryRequestToken = number;

export type LibraryQueryState = {
  readonly request: QueryLibraryItemsRequest;
  readonly page: LibraryQueryPage | null;
  readonly selectedItemId: string | null;
  readonly lastIssuedRequestToken: LibraryQueryRequestToken;
  readonly pendingRequestToken: LibraryQueryRequestToken | null;
};

export type LibraryQueryStateAction =
  | { readonly type: "set-query"; readonly query: string }
  | { readonly type: "set-filters"; readonly filters: LibraryQueryFilters }
  | { readonly type: "set-sort"; readonly sort: LibraryQuerySort }
  | { readonly type: "set-page"; readonly page: LibraryQueryPageRequest }
  | {
      readonly type: "apply-saved-view";
      readonly id: string | null;
      readonly definition: SavedLibraryViewDefinition;
    }
  | { readonly type: "select-item"; readonly id: string | null };

export type IssuedLibraryQueryRequest = {
  readonly token: LibraryQueryRequestToken;
  readonly request: QueryLibraryItemsRequest;
};

export function createLibraryQueryState(
  request: QueryLibraryItemsRequest = DEFAULT_LIBRARY_QUERY_REQUEST,
): LibraryQueryState {
  return {
    request: queryLibraryItemsRequestSchema.parse(request),
    page: null,
    selectedItemId: null,
    lastIssuedRequestToken: 0,
    pendingRequestToken: null,
  };
}

function withRequest(
  state: LibraryQueryState,
  request: QueryLibraryItemsRequest,
): LibraryQueryState {
  return {
    ...state,
    request: queryLibraryItemsRequestSchema.parse(request),
    page: null,
    pendingRequestToken: null,
  };
}

export function libraryQueryStateReducer(
  state: LibraryQueryState,
  action: LibraryQueryStateAction,
): LibraryQueryState {
  switch (action.type) {
    case "set-query":
      return withRequest(state, {
        ...state.request,
        query: action.query,
        page: { ...state.request.page, offset: 0 },
      });
    case "set-filters":
      return withRequest(state, {
        ...state.request,
        filters: action.filters,
        page: { ...state.request.page, offset: 0 },
      });
    case "set-sort":
      return withRequest(state, {
        ...state.request,
        sort: action.sort,
        page: { ...state.request.page, offset: 0 },
      });
    case "set-page":
      return withRequest(state, { ...state.request, page: action.page });
    case "apply-saved-view": {
      const definition = savedLibraryViewDefinitionSchema.parse(action.definition);
      return withRequest(state, {
        ...(action.id === null ? {} : { virtualLibraryId: action.id }),
        query: "",
        filters: DEFAULT_LIBRARY_QUERY_REQUEST.filters,
        sort: definition.sort,
        page: { ...state.request.page, offset: 0 },
      });
    }
    case "select-item":
      if (
        action.id !== null &&
        !state.page?.items.some(({ id }) => id === action.id)
      ) {
        return state;
      }
      return { ...state, selectedItemId: action.id };
  }
}

export function issueLibraryQueryRequest(state: LibraryQueryState): {
  readonly state: LibraryQueryState;
  readonly request: IssuedLibraryQueryRequest;
} {
  const token = state.lastIssuedRequestToken + 1;
  return {
    state: {
      ...state,
      lastIssuedRequestToken: token,
      pendingRequestToken: token,
    },
    request: { token, request: state.request },
  };
}

export function boundedLibraryPageOffset(
  offset: number,
  total: number,
  limit: number,
): number {
  const lastPageOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  return Math.min(offset, lastPageOffset);
}

export function reconcileLibrarySelection(
  selectedItemId: string | null,
  page: LibraryQueryPage,
): string | null {
  if (page.items.some(({ id }) => id === selectedItemId)) {
    return selectedItemId;
  }
  return page.items[0]?.id ?? null;
}

export function applyLibraryQueryResponse(
  state: LibraryQueryState,
  token: LibraryQueryRequestToken,
  page: LibraryQueryPage,
): LibraryQueryState {
  if (token !== state.pendingRequestToken) {
    return state;
  }

  const parsedPage = libraryQueryPageSchema.parse(page);
  if (
    parsedPage.page.offset !== state.request.page.offset ||
    parsedPage.page.limit !== state.request.page.limit
  ) {
    return state;
  }

  const boundedOffset = boundedLibraryPageOffset(
    state.request.page.offset,
    parsedPage.total,
    state.request.page.limit,
  );
  if (boundedOffset !== state.request.page.offset) {
    return {
      ...state,
      request: {
        ...state.request,
        page: { ...state.request.page, offset: boundedOffset },
      },
      page: null,
      selectedItemId: null,
      pendingRequestToken: null,
    };
  }

  return {
    ...state,
    page: parsedPage,
    selectedItemId: reconcileLibrarySelection(state.selectedItemId, parsedPage),
    pendingRequestToken: null,
  };
}
