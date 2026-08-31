import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH } from "@takio/library-contract";

import "./SaveLibraryViewDialog.css";

export type SaveLibraryViewDialogProps = {
  readonly open: boolean;
  readonly suggestedName: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (name: string) => void;
};

export type SavedLibraryViewNameValidation =
  | { readonly name: string; readonly error: null }
  | { readonly name: null; readonly error: string };

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function saveDialogFocusTarget(
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

export function validateSavedLibraryViewName(value: string): SavedLibraryViewNameValidation {
  const name = value.trim();
  if (name.length === 0) {
    return { name: null, error: "Enter a name for this virtual library." };
  }
  if (name.length > MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH) {
    return {
      name: null,
      error: `Use ${MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH} characters or fewer.`,
    };
  }
  return { name, error: null };
}

export function SaveLibraryViewDialog({
  open,
  suggestedName,
  busy,
  error,
  onCancel,
  onSave,
}: SaveLibraryViewDialogProps) {
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const [name, setName] = useState(suggestedName);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) {
      return;
    }

    setName(suggestedName);
    setValidationError(null);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, suggestedName]);

  if (!open) {
    return null;
  }

  const visibleError = validationError ?? (error?.trim() || null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) {
      return;
    }

    const result = validateSavedLibraryViewName(name);
    setValidationError(result.error);
    if (result.name !== null) {
      onSave(result.name);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
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
    const targetIndex = saveDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="save-library-view-dialog__overlay">
      <section
        ref={dialogRef}
        className="save-library-view-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <form onSubmit={handleSubmit}>
          <header className="save-library-view-dialog__header">
            <h2 id={titleId}>Save virtual library</h2>
          </header>

          <div className="save-library-view-dialog__body">
            <label htmlFor={inputId}>Virtual library name</label>
            <input
              ref={inputRef}
              id={inputId}
              name="saved-library-view-name"
              type="text"
              autoComplete="off"
              maxLength={MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH}
              value={name}
              disabled={busy}
              aria-invalid={visibleError !== null}
              aria-describedby={visibleError === null ? undefined : errorId}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setValidationError(null);
              }}
            />
            {visibleError !== null && (
              <p className="save-library-view-dialog__error" id={errorId} role="alert">
                {visibleError}
              </p>
            )}
          </div>

          <footer className="save-library-view-dialog__actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save virtual library"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
