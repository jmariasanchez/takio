import { useSyncExternalStore, type ReactNode } from "react";

import { CompactPaneDrawer, type CompactPane } from "./CompactPaneDrawer";
import "./LibraryWorkspaceLayout.css";

export type LibraryWorkspaceLayoutProps = {
  readonly facets: ReactNode;
  readonly facetsLabel?: string;
  readonly inspector: ReactNode;
  readonly inspectorLabel?: string;
  readonly openPane: CompactPane | null;
  readonly table: ReactNode;
  readonly tableLabel?: string;
  readonly toolbar: ReactNode;
  readonly workspaceLabel?: string;
  readonly onOpenPaneChange: (pane: CompactPane | null) => void;
};

const compactLayoutQuery = "(max-width: 900px)";

function compactLayoutSnapshot(): boolean {
  return typeof window !== "undefined" && window.matchMedia(compactLayoutQuery).matches;
}

function subscribeToCompactLayout(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const query = window.matchMedia(compactLayoutQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useCompactLayout(): boolean {
  return useSyncExternalStore(
    subscribeToCompactLayout,
    compactLayoutSnapshot,
    compactLayoutSnapshot,
  );
}

// Mount either desktop panes or drawer panes so interactive slot content and fixed IDs exist once.
export function LibraryWorkspaceLayout({
  facets,
  facetsLabel = "Filter books",
  inspector,
  inspectorLabel = "Book details",
  openPane,
  table,
  tableLabel = "Library results",
  toolbar,
  workspaceLabel = "Library workspace",
  onOpenPaneChange,
}: LibraryWorkspaceLayoutProps) {
  const compact = useCompactLayout();

  return (
    <section className="library-workspace-layout" aria-label={workspaceLabel}>
      <header className="library-workspace-layout__header" aria-label="Library toolbar">
        <div className="library-workspace-layout__toolbar">{toolbar}</div>
        {compact ? (
          <div className="library-workspace-layout__compact-controls">
            <CompactPaneDrawer
              facets={facets}
              facetsLabel={facetsLabel}
              inspector={inspector}
              inspectorLabel={inspectorLabel}
              openPane={openPane}
              onOpenPaneChange={onOpenPaneChange}
            />
          </div>
        ) : null}
      </header>

      <div className="library-workspace-layout__body">
        {compact ? null : (
          <aside
            className="library-workspace-layout__pane library-workspace-layout__pane--facets"
            aria-label={facetsLabel}
          >
            {facets}
          </aside>
        )}

        <section
          className="library-workspace-layout__pane library-workspace-layout__pane--table"
          aria-label={tableLabel}
        >
          {table}
        </section>

        {compact ? null : (
          <aside
            className="library-workspace-layout__pane library-workspace-layout__pane--inspector"
            aria-label={inspectorLabel}
          >
            {inspector}
          </aside>
        )}
      </div>
    </section>
  );
}
