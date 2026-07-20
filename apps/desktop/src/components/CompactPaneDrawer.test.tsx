import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CompactPaneDrawer, focusContainmentTarget } from "./CompactPaneDrawer";

function render(openPane: "facets" | "inspector" | null): string {
  return renderToStaticMarkup(
    <CompactPaneDrawer
      facets={<button type="button">Facet choice</button>}
      facetsLabel="Filter library"
      inspector={<button type="button">Open EPUB</button>}
      inspectorLabel="Book details"
      openPane={openPane}
      onOpenPaneChange={() => undefined}
    />,
  );
}

test("connects both compact triggers to mutually exclusive dialogs", () => {
  const markup = render("facets");
  const facetsId = markup.match(/aria-controls="([^"]+-compact-facets)"/)?.[1];
  const inspectorId = markup.match(/aria-controls="([^"]+-compact-inspector)"/)?.[1];

  expect(facetsId).toBeDefined();
  expect(inspectorId).toBeDefined();
  expect(markup).toContain(`aria-controls="${facetsId}" aria-expanded="true"`);
  expect(markup).toContain(`aria-controls="${inspectorId}" aria-expanded="false"`);
  expect(markup).toContain(`id="${facetsId}" role="dialog"`);
  expect(markup).toContain('aria-modal="true"');
  expect(markup).toContain(`id="${inspectorId}" role="dialog"`);
  expect(markup).toContain('aria-label="Close Filter library"');
});

test("keeps closed and inactive panes hidden and inert so their controls are not tabbable", () => {
  const closedMarkup = render(null);
  const openMarkup = render("inspector");

  expect(closedMarkup).toContain('compact-pane-drawer__overlay" hidden="" inert=""');
  expect(closedMarkup.match(/role="dialog"[^>]+hidden="" inert=""/g)).toHaveLength(2);
  expect(openMarkup).toContain('aria-label="Close Book details"');
  expect(openMarkup).toContain('aria-expanded="true" aria-haspopup="dialog">Book details');
  expect(openMarkup.match(/role="dialog"[^>]+hidden="" inert=""/g)).toHaveLength(1);
});

test("wraps focus only at containment boundaries", () => {
  expect(focusContainmentTarget(0, 3, true)).toBe(2);
  expect(focusContainmentTarget(2, 3, false)).toBe(0);
  expect(focusContainmentTarget(1, 3, false)).toBeNull();
  expect(focusContainmentTarget(1, 3, true)).toBeNull();
  expect(focusContainmentTarget(-1, 3, false)).toBe(0);
  expect(focusContainmentTarget(-1, 3, true)).toBe(2);
  expect(focusContainmentTarget(0, 0, false)).toBeNull();
});
