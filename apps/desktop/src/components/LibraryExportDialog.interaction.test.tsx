import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LibraryExportDialog } = await import("./LibraryExportDialog");

type Layout = Parameters<Parameters<typeof LibraryExportDialog>[0]["onConfirm"]>[0];

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

test("submits the explicitly selected filename and folder presets", () => {
  const confirmed: Layout[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <LibraryExportDialog
        open
        selectedCount={2}
        pending={false}
        onClose={() => undefined}
        onConfirm={(layout) => confirmed.push(layout)}
      />,
    );
  });

  const authorTitle = container.querySelector<HTMLInputElement>(
    'input[name="file-name-template"][value="author-title"]',
  );
  const series = container.querySelector<HTMLInputElement>(
    'input[name="directory-template"][value="series"]',
  );
  const form = container.querySelector("form");
  if (!authorTitle || !series || !form) {
    throw new Error("Expected export dialog controls");
  }

  act(() => {
    authorTitle.click();
    series.click();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  expect(confirmed).toEqual([
    { fileNameTemplate: "author-title", directoryTemplate: "series" },
  ]);
});
