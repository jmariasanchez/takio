import { afterAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LibraryWorkspaceLayout } from "./LibraryWorkspaceLayout";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

function setCompactLayout(compact: boolean): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: (query: string) => ({
        matches: compact && query === "(max-width: 900px)",
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    },
  });
}

function renderLayout(openPane: "facets" | "inspector" | null): string {
  return renderToStaticMarkup(
    <LibraryWorkspaceLayout
      facets={<button type="button">Science fiction</button>}
      facetsLabel="Filter library"
      inspector={<button type="button">Open EPUB</button>}
      inspectorLabel="Book details"
      openPane={openPane}
      table={<div role="table">Dense results</div>}
      tableLabel="Book results"
      toolbar={<input aria-label="Search books" />}
      onOpenPaneChange={() => undefined}
    />,
  );
}

test("renders a labelled full-height desktop workspace with three pane-local regions", () => {
  setCompactLayout(false);
  const markup = renderLayout(null);

  expect(markup).toContain('class="library-workspace-layout" aria-label="Library workspace"');
  expect(markup).toContain('<header class="library-workspace-layout__header" aria-label="Library toolbar"');
  expect(markup).toContain('<aside class="library-workspace-layout__pane library-workspace-layout__pane--facets" aria-label="Filter library"');
  expect(markup).toContain('<section class="library-workspace-layout__pane library-workspace-layout__pane--table" aria-label="Book results"');
  expect(markup).toContain('<aside class="library-workspace-layout__pane library-workspace-layout__pane--inspector" aria-label="Book details"');
  expect(markup.match(/Science fiction/g)).toHaveLength(1);
  expect(markup.match(/Open EPUB/g)).toHaveLength(1);
  expect(markup).not.toContain("compact-pane-drawer");
});

test("keeps the center primary and mounts one controlled compact drawer copy of each side pane", () => {
  setCompactLayout(true);
  const markup = renderLayout("inspector");

  expect(markup).toContain('aria-label="Book results"');
  expect(markup).toContain('role="group" aria-label="Library panels"');
  expect(markup).toContain('aria-expanded="false" aria-haspopup="dialog">Filter library');
  expect(markup).toContain('aria-expanded="true" aria-haspopup="dialog">Book details');
  expect(markup).toContain('role="dialog" aria-labelledby=');
  expect(markup).toContain('aria-modal="true"');
  expect(markup.match(/Science fiction/g)).toHaveLength(1);
  expect(markup.match(/Open EPUB/g)).toHaveLength(1);
  expect(markup).not.toContain('<aside');
});

test("reflects the controlled closed state without leaving compact drawer controls active", () => {
  setCompactLayout(true);
  const markup = renderLayout(null);

  expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(markup).toContain('compact-pane-drawer__overlay" hidden="" inert=""');
  expect(markup.match(/role="dialog"[^>]+hidden="" inert=""/g)).toHaveLength(2);
});
