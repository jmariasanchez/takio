import { useRef, type KeyboardEvent } from "react";
import type { LibraryItem } from "@takio/core";

import "./LibraryTable.css";

export type LibraryTableProps = {
  readonly busy?: boolean;
  readonly items: readonly LibraryItem[];
  readonly selectedItemId: string | null;
  readonly onOpenItem: (item: LibraryItem) => void;
  readonly onSelectItem: (id: string) => void;
};

type RowNavigationKey = "ArrowDown" | "ArrowUp" | "End" | "Home";

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

function addedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatLabel(format: string): string {
  return format.toUpperCase();
}

export function LibraryTable({
  busy = false,
  items,
  selectedItemId,
  onOpenItem,
  onSelectItem,
}: LibraryTableProps) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const selectedIndex = items.findIndex(({ id }) => id === selectedItemId);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;

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

  return (
    <div className="library-table-frame" aria-busy={busy}>
      <table className="library-table">
        <caption>Library books</caption>
        <colgroup>
          <col className="library-table__cover-column" />
          <col className="library-table__title-column" />
          <col className="library-table__author-column" />
          <col className="library-table__formats-column" />
          <col className="library-table__added-column" />
        </colgroup>
        <thead>
          <tr>
            <th aria-label="Cover" scope="col" />
            <th scope="col">Title</th>
            <th scope="col">Author</th>
            <th scope="col">Formats</th>
            <th scope="col">Added</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const selected = item.id === selectedItemId;

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
                aria-selected={selected}
                className={selected ? "library-table__row is-selected" : "library-table__row"}
                tabIndex={index === tabStopIndex ? 0 : -1}
                onClick={() => onSelectItem(item.id)}
                onDoubleClick={() => onOpenItem(item)}
                onFocus={() => onSelectItem(item.id)}
                onKeyDown={(event) => handleRowKeyDown(event, item, index)}
              >
                <td>
                  <span className="library-table__cover" aria-hidden="true">
                    {item.title.slice(0, 1).toUpperCase()}
                  </span>
                </td>
                <td>
                  <strong className="library-table__title">{item.title}</strong>
                </td>
                <td className="library-table__secondary">{item.author ?? "Unknown author"}</td>
                <td>
                  <span className="library-table__formats">
                    {item.formats.map(({ format }) => (
                      <span className="library-table__format" key={format}>
                        {formatLabel(format)}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="library-table__secondary">
                  <time dateTime={item.addedAt}>{addedDate(item.addedAt)}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
