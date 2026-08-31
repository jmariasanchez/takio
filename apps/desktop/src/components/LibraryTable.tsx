import type { LibraryItem } from "@takio/core";
import type { LibraryQuerySort } from "@takio/library-contract";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { libraryPageSelectionState } from "../lib/library-selection";
import { coverFileSource } from "../lib/desktop";
import type { CustomColumnDefinition } from "../lib/custom-columns";

import "./LibraryTable.css";

export type LibraryTableProps = {
  readonly busy?: boolean;
  readonly definitions?: readonly CustomColumnDefinition[];
  readonly visibleCustomColumnKey?: string | null;
  readonly onChangeVisibleCustomColumn?: (key: string | null) => void;
  readonly items: readonly LibraryItem[];
  readonly sort: LibraryQuerySort;
  readonly total: number;
  readonly pageOffset: number;
  readonly pageLimit: number;
  readonly selectedItemId: string | null;
  readonly selectedItemIds: readonly string[];
  readonly onChangePage: (offset: number) => void;
  readonly onChangeSort: (sort: LibraryQuerySort) => void;
  readonly onOpenItem: (item: LibraryItem) => void;
  readonly onSelectItem: (id: string) => void;
  readonly onToggleItem: (id: string) => void;
  readonly onSelectRange: (id: string, pageItemIds: readonly string[]) => void;
  readonly onTogglePage: (pageItemIds: readonly string[]) => void;
};

type PageAction = "next" | "previous";
type RowNavigationKey = "ArrowDown" | "ArrowUp" | "End" | "Home";
type SortField = LibraryQuerySort["field"];

const sortOptions = [
  ["title", "Title"],
  ["author", "Author"],
  ["series", "Series"],
  ["publishedDate", "Published"],
  ["rating", "Rating"],
  ["addedAt", "Added"],
  ["updatedAt", "Updated"],
] as const satisfies readonly (readonly [SortField, string])[];

export function nextLibrarySort(
  current: LibraryQuerySort,
  field: SortField,
): LibraryQuerySort {
  return {
    field,
    direction:
      current.field === field && current.direction === "ascending" ? "descending" : "ascending",
  };
}

export function libraryPageRange(
  pageOffset: number,
  itemCount: number,
  total: number,
): { readonly start: number; readonly end: number } {
  if (itemCount === 0 || total === 0) {
    return { start: 0, end: 0 };
  }

  return {
    start: pageOffset + 1,
    end: Math.min(pageOffset + itemCount, total),
  };
}

export function libraryPageTarget(
  action: PageAction,
  pageOffset: number,
  pageLimit: number,
  total: number,
): number | null {
  if (action === "previous") {
    return pageOffset === 0 ? null : Math.max(0, pageOffset - pageLimit);
  }

  return pageOffset + pageLimit >= total ? null : pageOffset + pageLimit;
}

export function rowNavigationTarget(
  key: RowNavigationKey,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount === 0) {
    return null;
  }

  switch (key) {
    case "ArrowDown":
      return Math.min(currentIndex + 1, itemCount - 1);
    case "ArrowUp":
      return Math.max(currentIndex - 1, 0);
    case "End":
      return itemCount - 1;
    case "Home":
      return 0;
  }
}

export function handleLibraryItemCheckboxClick(
  event: Readonly<{ shiftKey: boolean; stopPropagation: () => void }>,
  id: string,
  pageItemIds: readonly string[],
  onToggleItem: (id: string) => void,
  onSelectRange: (id: string, pageItemIds: readonly string[]) => void,
): void {
  event.stopPropagation();
  if (event.shiftKey) {
    onSelectRange(id, pageItemIds);
    return;
  }

  onToggleItem(id);
}

function addedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function authorLabel(item: LibraryItem): string {
  if (item.authors?.length) {
    return item.authors.map(({ name }) => name).join(", ");
  }

  return item.author ?? "Unknown author";
}

function formatLabel(format: string): string {
  return format.toUpperCase();
}

function sortDirectionLabel(direction: LibraryQuerySort["direction"]): string {
  return direction === "ascending" ? "Ascending" : "Descending";
}

export function LibraryTable({
  busy = false,
  definitions = [],
  visibleCustomColumnKey = null,
  onChangeVisibleCustomColumn = () => undefined,
  items,
  sort,
  total,
  pageOffset,
  pageLimit,
  selectedItemId,
  selectedItemIds,
  onChangePage,
  onChangeSort,
  onOpenItem,
  onSelectItem,
  onToggleItem,
  onSelectRange,
  onTogglePage,
}: LibraryTableProps) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const pageCheckboxRef = useRef<HTMLInputElement>(null);
  const pageItemIds = items.map(({ id }) => id);
  const selectedIds = new Set(selectedItemIds);
  const pageSelection = libraryPageSelectionState(selectedItemIds, pageItemIds);
  const selectedIndex = items.findIndex(({ id }) => id === selectedItemId);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const range = libraryPageRange(pageOffset, items.length, total);
  const previousPage = libraryPageTarget("previous", pageOffset, pageLimit, total);
  const nextPage = libraryPageTarget("next", pageOffset, pageLimit, total);
  const visibleCustomColumn = definitions.find(({ key }) => key === visibleCustomColumnKey) ?? null;

  useEffect(() => {
    if (pageCheckboxRef.current) {
      pageCheckboxRef.current.indeterminate = pageSelection === "some";
    }
  }, [pageSelection]);

  function moveRowFocus(currentIndex: number, key: RowNavigationKey): void {
    const targetIndex = rowNavigationTarget(key, currentIndex, items.length);
    if (targetIndex === null || targetIndex === currentIndex) {
      return;
    }

    const target = items[targetIndex];
    if (!target) {
      return;
    }

    onSelectItem(target.id);
    rowRefs.current.get(target.id)?.focus();
  }

  function handleRowKeyDown(
    event: KeyboardEvent<HTMLTableRowElement>,
    item: LibraryItem,
    index: number,
  ): void {
    if (event.target !== event.currentTarget) {
      return;
    }

    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "End" ||
      event.key === "Home"
    ) {
      event.preventDefault();
      moveRowFocus(index, event.key);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onOpenItem(item);
    }
  }

  function handleHeaderSort(field: SortField): void {
    onChangeSort(nextLibrarySort(sort, field));
  }

  return (
    <div className="library-table-shell" aria-busy={busy}>
      <div className="library-table__sort-controls">
        <label>
          <span>Sort by</span>
          <select
            aria-label="Sort field"
            value={sort.field}
            onChange={(event) =>
              onChangeSort({
                field: event.currentTarget.value as SortField,
                direction: sort.direction,
              })
            }
          >
            {sortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label={`Change sort direction to ${
            sort.direction === "ascending" ? "descending" : "ascending"
          }`}
          onClick={() =>
            onChangeSort({
              ...sort,
              direction: sort.direction === "ascending" ? "descending" : "ascending",
            })
          }
        >
          {sortDirectionLabel(sort.direction)}
        </button>
        <label>
          <span>Custom column</span>
          <select
            aria-label="Visible custom column"
            value={visibleCustomColumn?.key ?? ""}
            onChange={(event) => onChangeVisibleCustomColumn(event.currentTarget.value || null)}
          >
            <option value="">None</option>
            {definitions.map(({ key, label }) => (
              <option key={key} value={key}>
                {label} (#{key})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="library-table-frame">
        <table className="library-table">
          <caption>Library books</caption>
          <colgroup>
            <col className="library-table__selection-column" />
            <col className="library-table__cover-column" />
            <col className="library-table__title-column" />
            <col className="library-table__author-column" />
            <col className="library-table__formats-column" />
            {visibleCustomColumn && <col className="library-table__custom-column" />}
            <col className="library-table__added-column" />
          </colgroup>
          <thead>
            <tr>
              <th className="library-table__selection-cell" scope="col">
                <input
                  ref={pageCheckboxRef}
                  type="checkbox"
                  aria-label="Select current page"
                  checked={pageSelection === "all"}
                  disabled={busy || pageItemIds.length === 0}
                  onChange={() => onTogglePage(pageItemIds)}
                />
              </th>
              <th className="library-table__cover-cell" aria-label="Cover" scope="col" />
              <th aria-sort={sort.field === "title" ? sort.direction : undefined} scope="col">
                <button
                  type="button"
                  aria-label={`Sort by Title ${
                    nextLibrarySort(sort, "title").direction
                  }`}
                  onClick={() => handleHeaderSort("title")}
                >
                  Title
                  {sort.field === "title" ? (
                    <span aria-hidden="true">{sort.direction === "ascending" ? "↑" : "↓"}</span>
                  ) : null}
                </button>
              </th>
              <th aria-sort={sort.field === "author" ? sort.direction : undefined} scope="col">
                <button
                  type="button"
                  aria-label={`Sort by Author ${
                    nextLibrarySort(sort, "author").direction
                  }`}
                  onClick={() => handleHeaderSort("author")}
                >
                  Author
                  {sort.field === "author" ? (
                    <span aria-hidden="true">{sort.direction === "ascending" ? "↑" : "↓"}</span>
                  ) : null}
                </button>
              </th>
              <th className="library-table__formats-cell" scope="col">
                Formats
              </th>
              {visibleCustomColumn && (
                <th className="library-table__custom-cell" scope="col">
                  {visibleCustomColumn.label} <span>#{visibleCustomColumn.key}</span>
                </th>
              )}
              <th
                className="library-table__added-cell"
                aria-sort={sort.field === "addedAt" ? sort.direction : undefined}
                scope="col"
              >
                <button
                  type="button"
                  aria-label={`Sort by Added ${
                    nextLibrarySort(sort, "addedAt").direction
                  }`}
                  onClick={() => handleHeaderSort("addedAt")}
                >
                  Added
                  {sort.field === "addedAt" ? (
                    <span aria-hidden="true">{sort.direction === "ascending" ? "↑" : "↓"}</span>
                  ) : null}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const selected = item.id === selectedItemId;
              const checked = selectedIds.has(item.id);

              return (
                <tr
                  ref={(node) => {
                    if (node) {
                      rowRefs.current.set(item.id, node);
                    } else {
                      rowRefs.current.delete(item.id);
                    }
                  }}
                  key={item.id}
                  id={`library-item-${item.id}`}
                  aria-selected={selected}
                  className={selected ? "library-table__row is-selected" : "library-table__row"}
                  tabIndex={index === tabStopIndex ? 0 : -1}
                  onClick={() => onSelectItem(item.id)}
                  onDoubleClick={() => onOpenItem(item)}
                  onFocus={() => onSelectItem(item.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, item, index)}
                >
                  <td className="library-table__selection-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.title}`}
                      checked={checked}
                      disabled={busy}
                      onChange={() => undefined}
                      onClick={(event) =>
                        handleLibraryItemCheckboxClick(
                          event,
                          item.id,
                          pageItemIds,
                          onToggleItem,
                          onSelectRange,
                        )
                      }
                      onDoubleClick={(event) => event.stopPropagation()}
                      onFocus={(event) => event.stopPropagation()}
                    />
                  </td>
                  <td className="library-table__cover-cell">
                    {item.coverPath ? (
                      <img
                        className="library-table__cover"
                        src={coverFileSource(item.coverPath)}
                        alt={`Cover of ${item.title}`}
                      />
                    ) : (
                      <span className="library-table__cover" aria-hidden="true">
                        {item.title.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td>
                    <strong className="library-table__title">{item.title}</strong>
                  </td>
                  <td className="library-table__secondary">{authorLabel(item)}</td>
                  <td className="library-table__formats-cell">
                    <span className="library-table__formats">
                      {item.formats.map(({ format }) => (
                        <span className="library-table__format" key={format}>
                          {formatLabel(format)}
                        </span>
                      ))}
                    </span>
                  </td>
                  {visibleCustomColumn && (
                    <td className="library-table__custom-cell">
                      {item.customMetadata?.[visibleCustomColumn.key] ?? "Not set"}
                    </td>
                  )}
                  <td className="library-table__added-cell library-table__secondary">
                    <time dateTime={item.addedAt}>{addedDate(item.addedAt)}</time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="library-table__pager" role="navigation" aria-label="Library pages">
        <span aria-live="polite">
          {range.start === 0 ? `0 of ${total}` : `${range.start}–${range.end} of ${total}`}
        </span>
        <div>
          <button
            type="button"
            disabled={busy || previousPage === null}
            onClick={() => {
              if (previousPage !== null) {
                onChangePage(previousPage);
              }
            }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={busy || nextPage === null}
            onClick={() => {
              if (nextPage !== null) {
                onChangePage(nextPage);
              }
            }}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
