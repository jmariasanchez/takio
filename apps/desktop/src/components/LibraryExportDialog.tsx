import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import "./LibraryExportDialog.css";

export type LibraryExportFileNameTemplate = "title" | "author-title";

export type LibraryExportDialogProps = {
  readonly open: boolean;
  readonly selectedCount: number;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (template: LibraryExportFileNameTemplate) => void;
};

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function exportDialogFocusTarget(
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

export function LibraryExportDialog({
  open,
  selectedCount,
  pending,
  onClose,
  onConfirm,
}: LibraryExportDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const descriptionId = `${instanceId}-description`;
  const dialogRef = useRef<HTMLElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [template, setTemplate] = useState<LibraryExportFileNameTemplate>("title");
  const selectionLabel = `${selectedCount} ${selectedCount === 1 ? "book" : "books"}`;

  useEffect(() => {
    const opening = open && !wasOpen.current;
    const closing = !open && wasOpen.current;
    wasOpen.current = open;

    if (opening) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTemplate("title");
      const frame = window.requestAnimationFrame(() => firstOptionRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
    if (closing) {
      const frame = window.requestAnimationFrame(() => returnFocusRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const target = exportDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (target !== null) {
      event.preventDefault();
      focusable[target]?.focus();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!pending) {
      onConfirm(template);
    }
  }

  return (
    <div className="library-export-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={pending}
        onKeyDown={handleKeyDown}
      >
        <form onSubmit={handleSubmit}>
          <header className="library-export-dialog__header">
            <div>
              <span className="library-export-dialog__eyebrow">Save to disk</span>
              <h2 id={titleId}>Choose filename style</h2>
            </div>
            <button type="button" disabled={pending} aria-label="Close" onClick={onClose}>
              Close
            </button>
          </header>

          <div className="library-export-dialog__body">
            <p id={descriptionId}>
              Choose how filenames begin for <strong>{selectionLabel}</strong>. Takio keeps a
              stable suffix to prevent filename collisions.
            </p>
            <fieldset disabled={pending}>
              <legend>Filename style</legend>
              <label>
                <input
                  ref={firstOptionRef}
                  type="radio"
                  name="file-name-template"
                  value="title"
                  checked={template === "title"}
                  onChange={() => setTemplate("title")}
                />
                <span>
                  <strong>Title</strong>
                  <small>The Left Hand of Darkness</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="file-name-template"
                  value="author-title"
                  checked={template === "author-title"}
                  onChange={() => setTemplate("author-title")}
                />
                <span>
                  <strong>Author - title</strong>
                  <small>Ursula K. Le Guin - The Left Hand of Darkness</small>
                </span>
              </label>
            </fieldset>
          </div>

          <footer className="library-export-dialog__actions">
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button className="library-export-dialog__primary" type="submit" disabled={pending}>
              {pending ? "Preparing…" : "Choose folder…"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
