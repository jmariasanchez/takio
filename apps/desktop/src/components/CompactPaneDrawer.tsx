import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import "./CompactPaneDrawer.css";

export type CompactPane = "facets" | "inspector";

export const compactFacetsTriggerId = "library-compact-facets-trigger";

export type CompactPaneDrawerProps = {
  readonly facets: ReactNode;
  readonly facetsLabel?: string;
  readonly inspector: ReactNode;
  readonly inspectorLabel?: string;
  readonly openPane: CompactPane | null;
  readonly onOpenPaneChange: (pane: CompactPane | null) => void;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusContainmentTarget(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount === 0) {
    return null;
  }
  if (currentIndex < 0) {
    return backwards ? itemCount - 1 : 0;
  }
  if (backwards && currentIndex === 0) {
    return itemCount - 1;
  }
  if (!backwards && currentIndex === itemCount - 1) {
    return 0;
  }
  return null;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
}

export function CompactPaneDrawer({
  facets,
  facetsLabel = "Facets",
  inspector,
  inspectorLabel = "Inspector",
  openPane,
  onOpenPaneChange,
}: CompactPaneDrawerProps) {
  const instanceId = useId();
  const facetsPanelId = `${instanceId}-compact-facets`;
  const inspectorPanelId = `${instanceId}-compact-inspector`;
  const facetsTitleId = `${facetsPanelId}-title`;
  const inspectorTitleId = `${inspectorPanelId}-title`;
  const facetsTrigger = useRef<HTMLButtonElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const facetsPanel = useRef<HTMLElement>(null);
  const inspectorPanel = useRef<HTMLElement>(null);
  const facetsClose = useRef<HTMLButtonElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const previousOpenPane = useRef<CompactPane | null>(null);

  useEffect(() => {
    const previousPane = previousOpenPane.current;
    previousOpenPane.current = openPane;

    if (openPane === "facets") {
      facetsClose.current?.focus();
      return;
    }
    if (openPane === "inspector") {
      inspectorClose.current?.focus();
      return;
    }
    if (previousPane === "facets") {
      facetsTrigger.current?.focus();
    } else if (previousPane === "inspector") {
      inspectorTrigger.current?.focus();
    }
  }, [openPane]);

  function handlePanelKeyDown(
    event: KeyboardEvent<HTMLElement>,
    pane: CompactPane,
  ): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpenPaneChange(null);
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const panel = pane === "facets" ? facetsPanel.current : inspectorPanel.current;
    if (!panel) {
      return;
    }
    const focusable = focusableElements(panel);
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = focusContainmentTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="compact-pane-drawer">
      <div className="compact-pane-drawer__triggers" role="group" aria-label="Library panels">
        <button
          ref={facetsTrigger}
          id={compactFacetsTriggerId}
          type="button"
          aria-controls={facetsPanelId}
          aria-expanded={openPane === "facets"}
          aria-haspopup="dialog"
          onClick={() => onOpenPaneChange(openPane === "facets" ? null : "facets")}
        >
          {facetsLabel}
        </button>
        <button
          ref={inspectorTrigger}
          type="button"
          aria-controls={inspectorPanelId}
          aria-expanded={openPane === "inspector"}
          aria-haspopup="dialog"
          onClick={() => onOpenPaneChange(openPane === "inspector" ? null : "inspector")}
        >
          {inspectorLabel}
        </button>
      </div>

      <div
        className="compact-pane-drawer__overlay"
        hidden={openPane === null}
        inert={openPane === null}
      >
        <div
          className="compact-pane-drawer__backdrop"
          aria-hidden="true"
          onClick={() => onOpenPaneChange(null)}
        />

        <section
          ref={facetsPanel}
          className="compact-pane-drawer__panel compact-pane-drawer__panel--facets"
          id={facetsPanelId}
          role="dialog"
          aria-labelledby={facetsTitleId}
          aria-modal={openPane === "facets" ? "true" : undefined}
          hidden={openPane !== "facets"}
          inert={openPane !== "facets"}
          tabIndex={-1}
          onKeyDown={(event) => handlePanelKeyDown(event, "facets")}
        >
          <header className="compact-pane-drawer__header">
            <h2 id={facetsTitleId}>{facetsLabel}</h2>
            <button
              ref={facetsClose}
              type="button"
              aria-label={`Close ${facetsLabel}`}
              onClick={() => onOpenPaneChange(null)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div className="compact-pane-drawer__content">{facets}</div>
        </section>

        <section
          ref={inspectorPanel}
          className="compact-pane-drawer__panel compact-pane-drawer__panel--inspector"
          id={inspectorPanelId}
          role="dialog"
          aria-labelledby={inspectorTitleId}
          aria-modal={openPane === "inspector" ? "true" : undefined}
          hidden={openPane !== "inspector"}
          inert={openPane !== "inspector"}
          tabIndex={-1}
          onKeyDown={(event) => handlePanelKeyDown(event, "inspector")}
        >
          <header className="compact-pane-drawer__header">
            <h2 id={inspectorTitleId}>{inspectorLabel}</h2>
            <button
              ref={inspectorClose}
              type="button"
              aria-label={`Close ${inspectorLabel}`}
              onClick={() => onOpenPaneChange(null)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div className="compact-pane-drawer__content">{inspector}</div>
        </section>
      </div>
    </div>
  );
}
