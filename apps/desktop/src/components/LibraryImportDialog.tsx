import {
  MAX_LIBRARY_IMPORT_ROOTS,
  type LibraryImportMode,
  type LibraryImportEntryOutcome,
  type LibraryImportReport,
} from "@takio/library-contract";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import "./LibraryImportDialog.css";

export type LibraryImportDialogProps = {
  readonly open: boolean;
  readonly selectedRootPaths: readonly string[];
  readonly pending: boolean;
  readonly mode: LibraryImportMode;
  readonly report: LibraryImportReport | null;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onChooseFiles: () => void;
  readonly onChooseFolders: () => void;
  readonly onImport: () => void;
  readonly onModeChange: (mode: LibraryImportMode) => void;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function importDialogFocusTarget(
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

export function canStartLibraryImport(
  selectedRootPaths: readonly string[],
  pending: boolean,
): boolean {
  return (
    !pending &&
    selectedRootPaths.length >= 1 &&
    selectedRootPaths.length <= MAX_LIBRARY_IMPORT_ROOTS
  );
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function outcomeDetails(outcome: LibraryImportEntryOutcome): ReactNode {
  switch (outcome.status) {
    case "imported":
      return (
        <>
          <div>
            <dt>Status</dt>
            <dd><code>{outcome.status}</code></dd>
          </div>
          <div>
            <dt>Book</dt>
            <dd>{outcome.item.title}</dd>
          </div>
          {outcome.sourceCleanupPending === undefined ? null : (
            <div>
              <dt>Original</dt>
              <dd>{outcome.sourceCleanupPending ? "cleanup pending" : "removed"}</dd>
            </div>
          )}
        </>
      );
    case "skipped":
      return (
        <>
          <div>
            <dt>Status</dt>
            <dd><code>{outcome.status}</code></dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd><code>{outcome.reason}</code></dd>
          </div>
        </>
      );
    case "duplicate":
      return (
        <>
          <div>
            <dt>Status</dt>
            <dd><code>{outcome.status}</code></dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd><code>{outcome.reason}</code></dd>
          </div>
          <div>
            <dt>Existing</dt>
            <dd>{outcome.existing.itemId} · {outcome.existing.format.toUpperCase()}</dd>
          </div>
          {outcome.sourceCleanupPending === undefined ? null : (
            <div>
              <dt>Original</dt>
              <dd>{outcome.sourceCleanupPending ? "cleanup pending" : "removed"}</dd>
            </div>
          )}
        </>
      );
    case "failed":
      return (
        <>
          <div>
            <dt>Status</dt>
            <dd><code>{outcome.status}</code></dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd><code>{outcome.code}</code></dd>
          </div>
        </>
      );
  }
}

export function LibraryImportDialog({
  open,
  selectedRootPaths,
  pending,
  mode,
  report,
  error,
  onClose,
  onChooseFiles,
  onChooseFolders,
  onImport,
  onModeChange,
}: LibraryImportDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const descriptionId = `${instanceId}-description`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousOpen = useRef(false);
  const visibleError = error?.trim() || null;
  const canImport = canStartLibraryImport(selectedRootPaths, pending);
  const selectedRootsLabel = countLabel(selectedRootPaths.length, "selected root");
  const status = pending
    ? `Importing ${selectedRootsLabel}…`
    : report === null
      ? selectedRootPaths.length === 0
        ? `Choose between 1 and ${MAX_LIBRARY_IMPORT_ROOTS} files or folders.`
        : `${selectedRootsLabel} ready to import.`
      : `Import finished. ${countLabel(report.counts.total, "outcome")} reviewed.`;

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
    const targetIndex = importDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="library-import-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${statusId}${visibleError === null ? "" : ` ${errorId}`}`}
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="library-import-dialog__header">
          <div>
            <span className="library-import-dialog__eyebrow">Library intake</span>
            <h2 id={titleId}>Import books</h2>
            <p id={descriptionId}>
              Choose files or folders. Folders are scanned recursively for supported books.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            className="library-import-dialog__close"
            type="button"
            aria-label="Close import"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="library-import-dialog__status" id={statusId} role="status" aria-live="polite">
          {status}
        </div>

        {visibleError !== null ? (
          <p className="library-import-dialog__error" id={errorId} role="alert">{visibleError}</p>
        ) : null}

        <div className="library-import-dialog__body">
          <fieldset className="library-import-dialog__mode" disabled={pending}>
            <legend>What should Takio do with the originals?</legend>
            <label>
              <input
                type="radio"
                name={`${instanceId}-mode`}
                value="copy"
                checked={mode === "copy"}
                onChange={() => onModeChange("copy")}
              />
              <span>
                <strong>Keep originals</strong>
                <small>Copy books into Takio and leave the selected files where they are.</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={`${instanceId}-mode`}
                value="move"
                checked={mode === "move"}
                onChange={() => onModeChange("move")}
              />
              <span>
                <strong>Organize into Takio</strong>
                <small>
                  Takio removes each original only after its managed copy is verified.
                </small>
              </span>
            </label>
          </fieldset>

          <section className="library-import-dialog__roots" aria-labelledby={`${instanceId}-roots`}>
            <div className="library-import-dialog__section-heading">
              <div>
                <h3 id={`${instanceId}-roots`}>Selected roots</h3>
                <span>{selectedRootsLabel}</span>
              </div>
              <div className="library-import-dialog__root-actions">
                <button type="button" disabled={pending} onClick={onChooseFiles}>
                  Choose files…
                </button>
                <button type="button" disabled={pending} onClick={onChooseFolders}>
                  Choose folders…
                </button>
              </div>
            </div>
            {selectedRootPaths.length === 0 ? (
              <p className="library-import-dialog__empty">No files or folders selected.</p>
            ) : (
              <ol className="library-import-dialog__root-list">
                {selectedRootPaths.map((path, index) => (
                  <li key={`${index}:${path}`}><code>{path}</code></li>
                ))}
              </ol>
            )}
          </section>

          {report !== null ? (
            <section className="library-import-dialog__report" aria-labelledby={`${instanceId}-report`}>
              <div className="library-import-dialog__section-heading">
                <div>
                  <h3 id={`${instanceId}-report`}>Import report</h3>
                  <span>Every discovered file is accounted for.</span>
                </div>
              </div>
              <ul className="library-import-dialog__counts" aria-label="Import counts">
                <li>{countLabel(report.counts.total, "total", "total")}</li>
                <li>{countLabel(report.counts.imported, "imported", "imported")}</li>
                <li>{countLabel(report.counts.skipped, "skipped", "skipped")}</li>
                <li>{countLabel(report.counts.duplicates, "duplicate")}</li>
                <li>{countLabel(report.counts.failed, "failed", "failed")}</li>
              </ul>
              <ol className="library-import-dialog__outcomes" aria-label="Import results">
                {report.outcomes.map((outcome, index) => (
                  <li
                    className={`library-import-dialog__outcome library-import-dialog__outcome--${outcome.status}`}
                    key={`${index}:${outcome.sourcePath}`}
                  >
                    <code className="library-import-dialog__path">{outcome.sourcePath}</code>
                    <dl>{outcomeDetails(outcome)}</dl>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <footer className="library-import-dialog__actions">
          <button type="button" onClick={onClose}>Close</button>
          <button
            type="button"
            className="library-import-dialog__import"
            disabled={!canImport}
            onClick={onImport}
          >
            {pending ? "Importing…" : "Import"}
          </button>
        </footer>
      </section>
    </div>
  );
}
