import { normalizeTags } from "@takio/core";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import "./LibraryBulkTagsDialog.css";

export type LibraryBulkTagsOperation = "add" | "remove" | "replace";

export type LibraryBulkTagsDialogProps = {
  readonly open: boolean;
  readonly selectedCount: number;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onApply: (
    operation: LibraryBulkTagsOperation,
    tags: readonly string[],
  ) => void;
};

export type LibraryBulkTagsValidation =
  | { readonly tags: readonly string[]; readonly error: null }
  | { readonly tags: null; readonly error: string };

const operationOptions: readonly Readonly<{
  value: LibraryBulkTagsOperation;
  label: string;
  description: string;
}>[] = [
  {
    value: "add",
    label: "Add",
    description: "Keep existing tags and add these tags.",
  },
  {
    value: "remove",
    label: "Remove",
    description: "Remove only these tags from each book.",
  },
  {
    value: "replace",
    label: "Replace",
    description: "Replace every existing tag with this complete list.",
  },
];

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function bulkTagsDialogFocusTarget(
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

export function parseBulkLibraryTags(value: string): readonly string[] {
  if (value.trim() === "") {
    return [];
  }

  const deduplicated: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = rawTag.trim().replace(/\s+/g, " ");
    if (tag.length === 0) {
      throw new TypeError("Tags must be nonempty.");
    }

    const comparison = tag.toLowerCase();
    if (!seen.has(comparison)) {
      seen.add(comparison);
      deduplicated.push(tag);
    }
  }

  return normalizeTags(deduplicated);
}

export function validateBulkLibraryTags(
  operation: LibraryBulkTagsOperation,
  value: string,
  clearConfirmed: boolean,
): LibraryBulkTagsValidation {
  let tags: readonly string[];
  try {
    tags = parseBulkLibraryTags(value);
  } catch {
    return {
      tags: null,
      error: "Enter comma-separated tags without empty entries.",
    };
  }

  if (tags.length > 0) {
    return { tags, error: null };
  }
  if (operation === "add") {
    return { tags: null, error: "Enter at least one tag to add." };
  }
  if (operation === "remove") {
    return { tags: null, error: "Enter at least one tag to remove." };
  }
  if (!clearConfirmed) {
    return { tags: null, error: "Confirm that you want to clear all tags." };
  }
  return { tags, error: null };
}

export function LibraryBulkTagsDialog({
  open,
  selectedCount,
  pending,
  error,
  onClose,
  onApply,
}: LibraryBulkTagsDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const descriptionId = `${instanceId}-description`;
  const inputId = `${instanceId}-tags`;
  const inputHelpId = `${instanceId}-tags-help`;
  const clearId = `${instanceId}-clear`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [operation, setOperation] = useState<LibraryBulkTagsOperation>("add");
  const [value, setValue] = useState("");
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleError = validationError ?? (error?.trim() || null);
  const selectionLabel = `${selectedCount} ${selectedCount === 1 ? "book" : "books"}`;

  useEffect(() => {
    const opening = open && !wasOpen.current;
    const closing = !open && wasOpen.current;
    wasOpen.current = open;

    if (opening) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOperation("add");
      setValue("");
      setClearConfirmed(false);
      setValidationError(null);
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }

    if (closing) {
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

  if (!open) {
    return null;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      return;
    }

    const result = validateBulkLibraryTags(operation, value, clearConfirmed);
    setValidationError(result.error);
    if (result.tags !== null) {
      onApply(operation, result.tags);
    }
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
    const targetIndex = bulkTagsDialogFocusTarget(
      currentIndex,
      focusable.length,
      event.shiftKey,
    );
    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="library-bulk-tags-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-bulk-tags-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${visibleError === null ? "" : ` ${errorId}`}`}
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <form onSubmit={handleSubmit}>
          <header className="library-bulk-tags-dialog__header">
            <div>
              <span className="library-bulk-tags-dialog__eyebrow">Bulk metadata</span>
              <h2 id={titleId}>Edit tags</h2>
            </div>
            <button type="button" aria-label="Close tag editor" onClick={onClose}>
              Close
            </button>
          </header>

          <div className="library-bulk-tags-dialog__body">
            <p id={descriptionId} className="library-bulk-tags-dialog__selection">
              Update tags for <strong>{selectionLabel}</strong>.
            </p>

            <fieldset className="library-bulk-tags-dialog__operations" disabled={pending}>
              <legend>Operation</legend>
              <div className="library-bulk-tags-dialog__operation-grid">
                {operationOptions.map((option) => {
                  const optionId = `${instanceId}-${option.value}`;
                  return (
                    <label key={option.value} htmlFor={optionId}>
                      <input
                        id={optionId}
                        type="radio"
                        name="library-bulk-tags-operation"
                        value={option.value}
                        checked={operation === option.value}
                        onChange={() => {
                          setOperation(option.value);
                          setClearConfirmed(false);
                          setValidationError(null);
                        }}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="library-bulk-tags-dialog__input">
              <label htmlFor={inputId}>Tags</label>
              <textarea
                ref={inputRef}
                id={inputId}
                name="library-bulk-tags"
                rows={3}
                autoComplete="off"
                placeholder="Science fiction, Classic, Award winner"
                value={value}
                disabled={pending}
                aria-invalid={visibleError !== null}
                aria-describedby={`${inputHelpId}${visibleError === null ? "" : ` ${errorId}`}`}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  setValidationError(null);
                }}
              />
              <small id={inputHelpId}>
                Separate tags with commas. Spacing is normalized and duplicate names are used once.
              </small>
            </div>

            <div
              className="library-bulk-tags-dialog__clear"
              hidden={operation !== "replace"}
            >
              <label htmlFor={clearId}>
                <input
                  id={clearId}
                  type="checkbox"
                  checked={clearConfirmed}
                  disabled={pending}
                  onChange={(event) => {
                    setClearConfirmed(event.currentTarget.checked);
                    setValidationError(null);
                  }}
                />
                <span>
                  <strong>Allow an empty replacement</strong>
                  <small>This clears every tag from all {selectionLabel}.</small>
                </span>
              </label>
            </div>

            <p
              id={statusId}
              className="library-bulk-tags-dialog__status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {pending ? `Updating tags for ${selectionLabel}…` : ""}
            </p>

            {visibleError !== null && (
              <p id={errorId} className="library-bulk-tags-dialog__error" role="alert">
                {visibleError}
              </p>
            )}
          </div>

          <footer className="library-bulk-tags-dialog__actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending}>
              {pending ? "Updating…" : "Apply tags"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
