import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LibraryTable } = await import("./LibraryTable");

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

afterAll(() => GlobalRegistrator.unregister());

test("the keyboard-accessible chooser replaces the single visible session column", () => {
  const changes: Array<string | null> = [];
  const item = {
    id: "item-1",
    title: "Kindred",
    sourcePath: "/Books/kindred.epub",
    format: "epub",
    formats: [{ sourcePath: "/Books/kindred.epub", format: "epub", provenance: "managed", addedAt: "2026-07-18T12:00:00.000Z" }],
    addedAt: "2026-07-18T12:00:00.000Z",
    tags: [],
    customMetadata: { shelf: "Favorites" },
  } as const;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const render = (key: string | null) => act(() => root?.render(
    <LibraryTable
      items={[item]}
      definitions={[
        { key: "shelf", label: "Shelf", type: "text", position: 0 },
        { key: "source_note", label: "Source note", type: "text", position: 1 },
      ]}
      visibleCustomColumnKey={key}
      sort={{ field: "title", direction: "ascending" }}
      total={1}
      pageOffset={0}
      pageLimit={25}
      selectedItemId="item-1"
      selectedItemIds={[]}
      onChangePage={() => undefined}
      onChangeSort={() => undefined}
      onChangeVisibleCustomColumn={(next) => changes.push(next)}
      onOpenItem={() => undefined}
      onSelectItem={() => undefined}
      onToggleItem={() => undefined}
      onSelectRange={() => undefined}
      onTogglePage={() => undefined}
    />,
  ));

  render("shelf");
  const chooser = container.querySelector<HTMLSelectElement>('[aria-label="Visible custom column"]');
  if (!chooser) throw new Error("Expected custom column chooser");
  expect(chooser.tabIndex).toBe(0);
  expect(container.querySelectorAll("th.library-table__custom-cell")).toHaveLength(1);

  act(() => {
    chooser.value = "source_note";
    chooser.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(changes).toEqual(["source_note"]);

  render("source_note");
  expect(container.querySelectorAll("th.library-table__custom-cell")).toHaveLength(1);
  expect(container.textContent).toContain("Source note #source_note");
  expect(container.textContent).toContain("Not set");
});
