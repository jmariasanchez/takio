import type { LibraryItem } from "@takio/core";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import "./LibraryTrashDialog.css";

export type LibraryTrashPendingAction = "purge" | "restore";

export type LibraryTrashDialogProps = {
  readonly open: boolean;
  readonly items: readonly LibraryItem[];
  readonly total: number;
  readonly pageOffset: number;
  readonly pageLimit: number;
  readonly loading: boolean;
  readonly pendingItemId: string | null;
  readonly pendingAction: LibraryTrashPendingAction | null;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onChangePage: (offset: number) => void;
  readonly onRestore: (item: LibraryItem) => void;
  readonly onPurge: (item: LibraryItem) => void;
};

type PageAction = "next" | "previous";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function trashDialogFocusTarget(
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

export function trashPageRange(
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

export function trashPageTarget(
  action: PageAction,
  pageOffset: number,
  pageLimit: number,
  total: number,
): number | null {
  if (pageLimit <= 0) {
    return null;
  }
  if (action === "previous") {
    return pageOffset === 0 ? null : Math.max(0, pageOffset - pageLimit);
  }

  return pageOffset + pageLimit >= total ? null : pageOffset + pageLimit;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
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

function pendingStatus(
  items: readonly LibraryItem[],
  pendingItemId: string | null,
  pendingAction: LibraryTrashPendingAction | null,
): string | null {
  if (pendingItemId === null || pendingAction === null) {
    return null;
  }

  const title = items.find(({ id }) => id === pendingItemId)?.title ?? "book";
  return pendingAction === "restore" ? `Restoring ${title}…` : `Deleting ${title}…`;
}

export function LibraryTrashDialog({
  open,
  items,
  total,
  pageOffset,
  pageLimit,
  loading,
  pendingItemId,
  pendingAction,
  error,
  onClose,
  onChangePage,
  onRestore,
  onPurge,
}: LibraryTrashDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousOpen = useRef(false);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const confirmationCancelRefs = useRef(new Map<string, HTMLButtonElement>());
  const [confirmingItemId, setConfirmingItemId] = useState<string | null>(null);
  const operationPending = pendingItemId !== null && pendingAction !== null;
  const range = trashPageRange(pageOffset, items.length, total);
  const previousPage = trashPageTarget("previous", pageOffset, pageLimit, total);
  const nextPage = trashPageTarget("next", pageOffset, pageLimit, total);
  const operationStatus = pendingStatus(items, pendingItemId, pendingAction);
  const visibleError = error?.trim() || null;

  useEffect(() => {
    const opening = open && !previousOpen.current;
    const closing = !open && previousOpen.current;
    previousOpen.current = open;

    if (opening) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }

    if (closing) {
      setConfirmingItemId(null);
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) {
          returnTarget.focus();
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }

    return;
  }, [open]);

  const confirmationItemVisible =
    confirmingItemId === null || items.some(({ id }) => id === confirmingItemId);

  useEffect(() => {
    if (!open || !confirmationItemVisible) {
      setConfirmingItemId(null);
    }
  }, [confirmationItemVisible, open]);

  useEffect(() => {
    if (confirmingItemId === null) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      confirmationCancelRefs.current.get(confirmingItemId)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [confirmingItemId]);

  if (!open) {
    return null;
  }

  function closeConfirmation(itemId: string): void {
    setConfirmingItemId(null);
    window.requestAnimationFrame(() => deleteButtonRefs.current.get(itemId)?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = trashDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="library-trash-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-trash-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${statusId}${visibleError === null ? "" : ` ${errorId}`}`}
        aria-busy={loading || operationPending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="library-trash-dialog__header">
          <div>
            <span className="library-trash-dialog__eyebrow">Library maintenance</span>
            <h2 id={titleId}>Trash</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="library-trash-dialog__close"
            type="button"
            aria-label="Close Trash"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="library-trash-dialog__summary">
          <strong>{items.length.toLocaleString()} visible</strong>
          <span>{total.toLocaleString()} total</span>
        </div>

        <div
          className="library-trash-dialog__status"
          id={statusId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {loading ? "Loading Trash…" : operationStatus ?? "Trash is up to date."}
        </div>

        {visibleError !== null ? (
          <p className="library-trash-dialog__error" id={errorId} role="alert">
            {visibleError}
          </p>
        ) : null}

        <div className="library-trash-dialog__body">
          {!loading && items.length === 0 ? (
            <div className="library-trash-dialog__empty">
              <strong>Trash is empty</strong>
              <span>Removed books will appear here until they are restored or deleted.</span>
            </div>
          ) : null}

          {items.length > 0 ? (
            <ul className="library-trash-dialog__list" aria-label="Trashed books">
              {items.map((item, index) => {
                const confirming = confirmingItemId === item.id;
                const restoring =
                  pendingItemId === item.id && pendingAction === "restore";
                const purging = pendingItemId === item.id && pendingAction === "purge";
                const confirmationId = `${instanceId}-confirmation-${index}`;

                return (
                  <li className="library-trash-dialog__item" key={item.id}>
                    <div className="library-trash-dialog__metadata">
                      <strong>{item.title}</strong>
                      <span>{authorLabel(item)}</span>
                      <span className="library-trash-dialog__formats" aria-label="Formats">
                        {item.formats.map(({ format }) => (
                          <span key={format}>{formatLabel(format)}</span>
                        ))}
                      </span>
                    </div>

                    <div
                      className="library-trash-dialog__item-actions"
                      hidden={confirming}
                      inert={confirming}
                    >
                      <button
                        type="button"
                        disabled={loading || operationPending}
                        aria-label={`Restore ${item.title}`}
                        onClick={() => onRestore(item)}
                      >
                        {restoring ? "Restoring…" : "Restore"}
                      </button>
                      <button
                        ref={(node) => {
                          if (node) {
                            deleteButtonRefs.current.set(item.id, node);
                          } else {
                            deleteButtonRefs.current.delete(item.id);
                          }
                        }}
                        className="library-trash-dialog__delete"
                        type="button"
                        disabled={loading || operationPending}
                        aria-label={`Permanently delete ${item.title}`}
                        aria-controls={confirmationId}
                        aria-expanded={confirming}
                        onClick={() => setConfirmingItemId(item.id)}
                      >
                        Permanently delete
                      </button>
                    </div>

                    <div
                      className="library-trash-dialog__confirmation"
                      id={confirmationId}
                      role="group"
                      aria-label={`Confirm permanent deletion of ${item.title}`}
                      hidden={!confirming}
                      inert={!confirming}
                    >
                      <p>
                        Permanently delete <strong>{item.title}</strong>? This cannot be undone.
                      </p>
                      <div>
                        <button
                          ref={(node) => {
                            if (node) {
                              confirmationCancelRefs.current.set(item.id, node);
                            } else {
                              confirmationCancelRefs.current.delete(item.id);
                            }
                          }}
                          type="button"
                          disabled={loading || operationPending}
                          onClick={() => closeConfirmation(item.id)}
                        >
                          Cancel
                        </button>
                        <button
                          className="library-trash-dialog__delete library-trash-dialog__delete--confirm"
                          type="button"
                          disabled={loading || operationPending}
                          onClick={() => onPurge(item)}
                        >
                          {purging ? "Deleting…" : "Delete forever"}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <footer className="library-trash-dialog__footer">
          <span aria-live="polite">
            {range.start === 0 ? `0 of ${total}` : `${range.start}–${range.end} of ${total}`}
          </span>
          <nav aria-label="Trash pages">
            <button
              type="button"
              disabled={loading || operationPending || previousPage === null}
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
              disabled={loading || operationPending || nextPage === null}
              onClick={() => {
                if (nextPage !== null) {
                  onChangePage(nextPage);
                }
              }}
            >
              Next
            </button>
          </nav>
        </footer>
      </section>
    </div>
  );
}
