import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { draftFor } = await import("../lib/metadata-draft");
const { LibraryWorkspace } = await import("./LibraryWorkspace");
const { MetadataEditor } = await import("./MetadataEditor");
import type { LibraryWorkspaceProps } from "./LibraryWorkspace";

const item = {
  id: "item-1",
  title: "Kindred",
  sourcePath: "/Books/kindred.epub",
  format: "epub",
  formats: [
    {
      sourcePath: "/Books/kindred.epub",
      format: "epub",
      provenance: "managed",
      addedAt: "2026-08-31T12:00:00.000Z",
    },
  ],
  addedAt: "2026-08-31T12:00:00.000Z",
  tags: [],
  customMetadata: { shelf: "Favorites" },
} as const;

const emptyFacets = { authors: [], tags: [], series: [], languages: [], formats: [] };
const emptyFilters = { authors: [], tags: [], series: [], languages: [], formats: [] };
const sort = { field: "title", direction: "ascending" } as const;

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  delete (window as Window & { takio?: unknown }).takio;
});

afterAll(() => GlobalRegistrator.unregister());

function workspaceProps(definitionGeneration: number): LibraryWorkspaceProps {
  return {
    actionsPending: false,
    conversionDraft: null,
    currentSavedViewId: null,
    definitionGeneration,
    draft: null,
    facets: emptyFacets,
    filters: emptyFilters,
    items: [item],
    libraryState: "ready",
    pageLimit: 25,
    pageOffset: 0,
    pendingAction: null,
    preferredDeviceFormat: null,
    query: "",
    querySyntax: "literal",
    savedViews: [],
    saveViewDialogBusy: false,
    saveViewDialogError: null,
    saveViewDialogOpen: false,
    saveViewSuggestedName: "Current library view",
    searchInput: { current: null },
    searchPending: false,
    selectedDestination: null,
    selectedItemId: item.id,
    selectedItemIds: [],
    sort,
    total: 1,
    onApplySavedView: () => undefined,
    onAttachFormat: async () => undefined,
    onCancelSaveView: () => undefined,
    onChangeFilters: () => undefined,
    onChangePage: () => undefined,
    onChangeSearch: () => undefined,
    onChangeSearchSyntax: () => undefined,
    onChangeSort: () => undefined,
    onChooseCover: async () => undefined,
    onClearAll: () => undefined,
    onClearCover: async () => undefined,
    onEnqueueConversion: async () => undefined,
    onMetadataCandidateApplied: () => undefined,
    onOpenDuplicateReview: () => undefined,
    onOpenImport: () => undefined,
    onOpenItem: async () => undefined,
    onOpenSaveView: () => undefined,
    onOpenTrash: () => undefined,
    onRemoveFormat: async () => undefined,
    onRemoveItem: async () => undefined,
    onRemoveSavedView: () => undefined,
    onRetry: async () => true,
    onSaveMetadata: async () => undefined,
    onSaveView: () => undefined,
    onSelectItem: () => undefined,
    onSelectItemRange: () => undefined,
    onSendItem: async () => undefined,
    onSetConversionDraft: () => undefined,
    onSetDraft: () => undefined,
    onTogglePageSelection: () => undefined,
    onToggleSelectedItem: () => undefined,
  };
}

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("reloads definitions for active-library reload, switch, and import generations", async () => {
  const calls: string[] = [];
  Object.defineProperty(window, "takio", {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        calls.push(command);
        return {
          ok: true,
          value: {
            definitions: [
              { key: "shelf", label: `Shelf ${calls.length}`, type: "text", position: 0 },
            ],
          },
        };
      },
    },
  });
  mount();

  for (const generation of [0, 1, 2, 3]) {
    await act(async () => root?.render(<LibraryWorkspace {...workspaceProps(generation)} />));
    await flush();
  }

  expect(calls).toEqual([
    "library_custom_columns_list",
    "library_custom_columns_list",
    "library_custom_columns_list",
    "library_custom_columns_list",
  ]);
  expect(container?.textContent).toContain("Shelf 4");
});

test("rejects a stale definition response after the active library changes", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  Object.defineProperty(window, "takio", {
    configurable: true,
    value: {
      invoke: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  });
  mount();

  await act(async () => root?.render(<LibraryWorkspace {...workspaceProps(0)} />));
  await flush();
  await act(async () => root?.render(<LibraryWorkspace {...workspaceProps(1)} />));
  await flush();

  resolvers[1]?.({
    ok: true,
    value: { definitions: [{ key: "shelf", label: "Current shelf", type: "text", position: 0 }] },
  });
  await flush();
  resolvers[0]?.({
    ok: true,
    value: { definitions: [{ key: "shelf", label: "Stale shelf", type: "text", position: 0 }] },
  });
  await flush();

  expect(container?.textContent).toContain("Current shelf");
  expect(container?.textContent).not.toContain("Stale shelf");
});

test("uses a defined custom value's visible label as its accessible name", () => {
  mount();
  const draft = draftFor(item);
  act(() => root?.render(
    <MetadataEditor
      definitions={[{ key: "shelf", label: "Shelf", type: "text", position: 0 }]}
      draft={{ ...draft, customMetadata: { ...draft.customMetadata, state: "concrete" } }}
      idPrefix="book-edit"
      onCancel={() => undefined}
      onChange={() => undefined}
      onSave={() => undefined}
    />,
  ));

  const value = container?.querySelector<HTMLTextAreaElement>("#book-edit-customMetadata-0-value");
  expect(value?.getAttribute("aria-label")).toBeNull();
  expect(value?.labels?.[0]?.querySelector("span")?.textContent).toBe("Shelf value");
});
