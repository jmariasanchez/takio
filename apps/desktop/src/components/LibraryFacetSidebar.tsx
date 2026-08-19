import type {
  LibraryFacetCounts,
  LibraryQueryFilters,
  SavedLibraryView,
} from "@takio/library-contract";

import "./LibraryFacetSidebar.css";

type FacetKey = keyof LibraryQueryFilters;
type FacetValue = LibraryFacetCounts[FacetKey][number];

export type LibraryFacetSidebarProps = {
  readonly facets: LibraryFacetCounts;
  readonly filters: LibraryQueryFilters;
  readonly savedViews: readonly SavedLibraryView[];
  readonly currentSavedViewId: string | null;
  readonly onChangeFilters: (filters: LibraryQueryFilters) => void;
  readonly onClearAll: () => void;
  readonly onApplySavedView: (id: string) => void;
  readonly onSaveSavedView: () => void;
  readonly onRemoveSavedView: (id: string) => void;
};

const facetGroups: readonly { key: FacetKey; label: string }[] = [
  { key: "authors", label: "Authors" },
  { key: "tags", label: "Tags" },
  { key: "series", label: "Series" },
  { key: "languages", label: "Languages" },
  { key: "formats", label: "Formats" },
];

function comparisonValue(key: FacetKey, value: string): string {
  return key === "formats" ? value : value.toLowerCase();
}

function isSelected(filters: LibraryQueryFilters, key: FacetKey, value: string): boolean {
  const comparison = comparisonValue(key, value);
  return (filters[key] as readonly string[]).some(
    (candidate) => comparisonValue(key, candidate) === comparison,
  );
}

function toggledFilters(
  filters: LibraryQueryFilters,
  key: FacetKey,
  value: string,
): LibraryQueryFilters {
  const comparison = comparisonValue(key, value);
  const current = filters[key] as readonly string[];
  const selected = current.some(
    (candidate) => comparisonValue(key, candidate) === comparison,
  );
  return {
    ...filters,
    [key]: selected
      ? current.filter((candidate) => comparisonValue(key, candidate) !== comparison)
      : [...current, value],
  } as LibraryQueryFilters;
}

function countLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "book" : "books"}`;
}

function displayValue(key: FacetKey, value: string): string {
  return key === "formats" ? value.toUpperCase() : value;
}

function removeFilter(
  filters: LibraryQueryFilters,
  key: FacetKey,
  value: string,
): LibraryQueryFilters {
  const comparison = comparisonValue(key, value);
  return {
    ...filters,
    [key]: (filters[key] as readonly string[]).filter(
      (candidate) => comparisonValue(key, candidate) !== comparison,
    ),
  } as LibraryQueryFilters;
}

export function LibraryFacetSidebar({
  facets,
  filters,
  savedViews,
  currentSavedViewId,
  onChangeFilters,
  onClearAll,
  onApplySavedView,
  onSaveSavedView,
  onRemoveSavedView,
}: LibraryFacetSidebarProps) {
  const activeFilters = facetGroups.flatMap(({ key, label }) =>
    (filters[key] as readonly string[]).map((value) => ({ key, label, value })),
  );

  return (
    <nav className="library-facets" aria-label="Library filters and saved views">
      <div className="library-facets__heading">
        <span className="library-facets__mark" aria-hidden="true">
          T
        </span>
        <span>Takio</span>
      </div>

      <div className="library-facets__body">
        <button
          type="button"
          className="library-facets__all"
          aria-label="All books, clear current query"
          onClick={onClearAll}
        >
          <span>All books</span>
          <span aria-hidden="true">Clear</span>
        </button>

        {activeFilters.length > 0 ? (
          <section
            className="library-facets__active"
            aria-labelledby="library-active-filters-heading"
          >
            <div className="library-facets__group-heading">
              <h2 id="library-active-filters-heading">Active filters</h2>
              <button type="button" onClick={onClearAll}>
                Clear all
              </button>
            </div>
            <ul className="library-facets__chips">
              {activeFilters.map(({ key, label, value }) => {
                const visibleValue = displayValue(key, value);
                return (
                  <li key={`${key}:${value}`}>
                    <button
                      type="button"
                      className="library-facets__chip"
                      aria-label={`Remove ${label} filter ${visibleValue}`}
                      onClick={() => onChangeFilters(removeFilter(filters, key, value))}
                    >
                      <span>
                        {label}: {visibleValue}
                      </span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section
          className="library-facets__group library-facets__saved"
          aria-labelledby="library-saved-views-heading"
        >
          <div className="library-facets__group-heading">
            <h2 id="library-saved-views-heading">Saved views</h2>
            <button type="button" onClick={onSaveSavedView}>
              Save current
            </button>
          </div>
          {savedViews.length === 0 ? (
            <p className="library-facets__empty">No saved views</p>
          ) : (
            <ul>
              {savedViews.map((view) => {
                const current = view.id === currentSavedViewId;
                return (
                  <li className="library-facets__saved-row" key={view.id}>
                    <button
                      type="button"
                      aria-pressed={current}
                      className={`library-facets__saved-view${current ? " is-selected" : ""}`}
                      onClick={() => onApplySavedView(view.id)}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      className="library-facets__remove"
                      aria-label={`Remove saved view ${view.name}`}
                      onClick={() => onRemoveSavedView(view.id)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {facetGroups.map(({ key, label }) => {
          const values = facets[key] as readonly FacetValue[];
          if (values.length === 0) {
            return null;
          }
          const headingId = `library-facet-${key}-heading`;
          return (
            <section className="library-facets__group" aria-labelledby={headingId} key={key}>
              <h2 id={headingId}>{label}</h2>
              <ul>
                {values.map(({ value, count }) => {
                  const selected = isSelected(filters, key, value);
                  const visibleValue = displayValue(key, value);
                  return (
                    <li key={value}>
                      <label
                        className={`library-facets__facet${selected ? " is-selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          aria-label={`${visibleValue}, ${countLabel(count)}`}
                          onChange={() => onChangeFilters(toggledFilters(filters, key, value))}
                        />
                        <span className="library-facets__label">{visibleValue}</span>
                        <span className="library-facets__count" aria-hidden="true">
                          {count.toLocaleString()}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
