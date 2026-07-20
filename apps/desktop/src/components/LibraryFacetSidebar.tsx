import "./LibraryFacetSidebar.css";

export type LibraryFacetView = {
  readonly count: number;
  readonly id: string;
  readonly label: string;
};

export type LibraryFacetGroup = {
  readonly id: string;
  readonly label: string;
  readonly views: readonly LibraryFacetView[];
};

export type LibraryFacetSidebarProps = {
  readonly groups: readonly LibraryFacetGroup[];
  readonly selectedViewId: string | null;
  readonly onSelectView: (id: string) => void;
};

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "book" : "books"}`;
}

export function LibraryFacetSidebar({
  groups,
  selectedViewId,
  onSelectView,
}: LibraryFacetSidebarProps) {
  return (
    <nav className="library-facets" aria-label="Library views">
      <div className="library-facets__heading">
        <span className="library-facets__mark" aria-hidden="true">
          T
        </span>
        <span>Takio</span>
      </div>

      <div className="library-facets__groups">
        {groups.map((group) => (
          <section
            className="library-facets__group"
            aria-labelledby={`library-facet-group-${group.id}`}
            key={group.id}
          >
            <h2 id={`library-facet-group-${group.id}`}>{group.label}</h2>
            <ul>
              {group.views.map((view) => {
                const selected = view.id === selectedViewId;

                return (
                  <li key={view.id}>
                    <button
                      type="button"
                      aria-label={`${view.label}, ${countLabel(view.count)}`}
                      aria-pressed={selected}
                      className={
                        selected
                          ? "library-facets__view is-selected"
                          : "library-facets__view"
                      }
                      onClick={() => onSelectView(view.id)}
                    >
                      <span>{view.label}</span>
                      <span className="library-facets__count" aria-hidden="true">
                        {view.count.toLocaleString()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
