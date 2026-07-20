import "./LibraryBulkActionBar.css";

export type LibraryBulkPendingAction =
  | "tags"
  | "export"
  | "convert"
  | "send"
  | "trash";

export type LibraryBulkActionBarProps = {
  readonly selectedCount: number;
  readonly disabled: boolean;
  readonly pendingAction: LibraryBulkPendingAction | null;
  readonly canConvert: boolean;
  readonly canSend: boolean;
  readonly onExport: () => void;
  readonly onEditTags: () => void;
  readonly onConvert: () => void;
  readonly onSend: () => void;
  readonly onMoveToTrash: () => void;
  readonly onClear: () => void;
};

const pendingLabels: Readonly<Record<LibraryBulkPendingAction, string>> = {
  tags: "Updating tags…",
  export: "Saving to disk…",
  convert: "Converting…",
  send: "Sending…",
  trash: "Moving to Trash…",
};

export function LibraryBulkActionBar({
  selectedCount,
  disabled,
  pendingAction,
  canConvert,
  canSend,
  onExport,
  onEditTags,
  onConvert,
  onSend,
  onMoveToTrash,
  onClear,
}: LibraryBulkActionBarProps) {
  if (selectedCount <= 0) {
    return null;
  }

  const pending = pendingAction !== null;
  const controlsDisabled = disabled || pending;
  const selectionLabel = `${selectedCount} ${selectedCount === 1 ? "book" : "books"} selected`;

  return (
    <section
      className="library-bulk-action-bar"
      aria-label="Bulk actions"
      aria-busy={pending}
    >
      <div
        className="library-bulk-action-bar__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>{selectionLabel}</strong>
        {pendingAction === null ? null : <span>{pendingLabels[pendingAction]}</span>}
      </div>

      <div className="library-bulk-action-bar__actions">
        <button
          className="library-bulk-action-bar__primary"
          type="button"
          disabled={controlsDisabled}
          title="Copy every attached format to a folder"
          onClick={onExport}
        >
          Save to disk…
        </button>
        <button type="button" disabled={controlsDisabled} onClick={onEditTags}>
          Edit tags
        </button>
        <button
          type="button"
          disabled={controlsDisabled || !canConvert}
          title={canConvert ? undefined : "Conversion is not available for this selection"}
          onClick={onConvert}
        >
          Convert
        </button>
        <button
          type="button"
          disabled={controlsDisabled || !canSend}
          title={canSend ? undefined : "Sending is not available for this selection"}
          onClick={onSend}
        >
          Send
        </button>
        <button
          className="library-bulk-action-bar__trash"
          type="button"
          disabled={controlsDisabled}
          onClick={onMoveToTrash}
        >
          Move to Trash
        </button>
        <button type="button" disabled={controlsDisabled} onClick={onClear}>
          Clear selection
        </button>
      </div>
    </section>
  );
}
