import type { LibraryHealthLocation, LibraryIntegrityReport } from "@takio/library-contract";
import { useEffect, useRef, type KeyboardEvent } from "react";

import "./LibraryHealthDialog.css";

export type LibraryHealthDialogProps = {
  readonly open: boolean;
  readonly location: LibraryHealthLocation | null;
  readonly loadingLocation: boolean;
  readonly lastVerification: { readonly checkedAt: string; readonly report: LibraryIntegrityReport } | null;
  readonly verificationError: string | null;
  readonly backupResult: { readonly path: string; readonly report: LibraryIntegrityReport } | null;
  readonly backupError: string | null;
  readonly pendingAction: "verify" | "backup" | null;
  readonly onClose: () => void;
  readonly onVerify: () => void;
  readonly onBackup: () => void;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function healthDialogFocusTarget(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount === 0) return null;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return null;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
}

export function formatLibraryHealthTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function backupDirectoryName(date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return `takio-library-backup-${stamp}`;
}

function Counts({ report }: { readonly report: LibraryIntegrityReport }) {
  return (
    <dl className="library-health-dialog__counts" aria-label="Integrity result counts">
      <div><dt>Total books</dt><dd>{report.items.total}</dd></div>
      <div><dt>Active</dt><dd>{report.items.active}</dd></div>
      <div><dt>Trashed</dt><dd>{report.items.trashed}</dd></div>
      <div><dt>Total formats</dt><dd>{report.formats.total}</dd></div>
      <div><dt>Managed formats</dt><dd>{report.formats.managed}</dd></div>
      <div><dt>Referenced formats</dt><dd>{report.formats.referenced}</dd></div>
    </dl>
  );
}

export function LibraryHealthDialog({
  open,
  location,
  loadingLocation,
  lastVerification,
  verificationError,
  backupResult,
  backupError,
  pendingAction,
  onClose,
  onVerify,
  onBackup,
}: LibraryHealthDialogProps) {
  const busy = pendingAction !== null;
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

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
        if (returnTarget?.isConnected) returnTarget.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    return;
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      if (busy) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = healthDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) return;

    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  const describedBy = [
    "library-health-location",
    lastVerification ? "library-health-last-check" : null,
    verificationError ? "library-health-error" : null,
    backupError ? "library-health-backup-error" : null,
    backupResult ? "library-health-backup-result" : null,
  ].filter(Boolean).join(" ");

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="library-health-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-health-title"
        aria-describedby={describedBy}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header>
          <div>
            <p className="eyebrow">Desktop storage</p>
            <h2 id="library-health-title">Library Health</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="ghost-button" disabled={busy} onClick={onClose}>Close</button>
        </header>

        <section id="library-health-location" className="library-health-dialog__section">
          <h3>Storage location</h3>
          {loadingLocation ? (
            <p role="status">Loading storage location...</p>
          ) : location ? (
            <dl className="library-health-dialog__paths">
              <div><dt>Library folder</dt><dd><code>{location.rootPath}</code></dd></div>
              <div><dt>Database</dt><dd><code>{location.databasePath}</code></dd></div>
            </dl>
          ) : (
            <p>Storage location is unavailable.</p>
          )}
        </section>

        <section className="library-health-dialog__section">
          <h3>Integrity</h3>
          {lastVerification ? (
            <>
              <p id="library-health-last-check">
                Last verified this session: {formatLibraryHealthTimestamp(lastVerification.checkedAt)}.
              </p>
              <Counts report={lastVerification.report} />
              <p className="library-health-dialog__fact">
                Managed formats are Takio-owned files included in backups. Referenced formats stay at their original paths and are counted but not copied into backups.
              </p>
            </>
          ) : (
            <p id="library-health-last-check">This library has not been verified in the current session.</p>
          )}
          {verificationError ? <p id="library-health-error" role="alert">{verificationError}</p> : null}
        </section>

        {backupResult ? (
          <section id="library-health-backup-result" className="library-health-dialog__section library-health-dialog__success">
            <h3>Backup complete</h3>
            <p><code>{backupResult.path}</code></p>
            <Counts report={backupResult.report} />
          </section>
        ) : null}
        {backupError ? <p id="library-health-backup-error" role="alert">{backupError}</p> : null}

        <footer>
          <button type="button" className="secondary-button" disabled={busy} onClick={onVerify}>
            {pendingAction === "verify" ? "Verifying..." : "Verify now"}
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={onBackup}>
            {pendingAction === "backup" ? "Backing up..." : "Back up..."}
          </button>
        </footer>
      </section>
    </div>
  );
}
