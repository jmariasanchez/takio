import "./LibraryBulkActionBar.css";

export type LibraryBulkPendingAction =
  | "tags"
  | "convert"
  | "send"
  | "trash";

export type LibraryBulkActionBarProps = {
  readonly selectedCount: number;
  readonly pendingAction: LibraryBulkPendingAction | null;
  readonly canConvert: boolean;
  readonly canSend: boolean;
  readonly onEditTags: () => void;
  readonly onConvert: () => void;
  readonly onSend: () => void;
  readonly onMoveToTrash: () => void;
  readonly onClear: () => void;
};

const pendingLabels: Readonly<Record<LibraryBulkPendingAction, string>> = {
  tags: "Updating tags…",
  convert: "Converting…",
  send: "Sending…",
  trash: "Moving to Trash…",
};

export function LibraryBulkActionBar({
  selectedCount,
  pendingAction,
  canConvert,
  canSend,
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
        <button type="button" disabled={pending} onClick={onEditTags}>
          Edit tags
        </button>
        <button
          type="button"
          disabled={pending || !canConvert}
          title={canConvert ? undefined : "Conversion is not available for this selection"}
          onClick={onConvert}
        >
          Convert
        </button>
        <button
          type="button"
          disabled={pending || !canSend}
          title={canSend ? undefined : "Sending is not available for this selection"}
          onClick={onSend}
        >
          Send
        </button>
        <button
          className="library-bulk-action-bar__trash"
          type="button"
          disabled={pending}
          onClick={onMoveToTrash}
        >
          Move to Trash
        </button>
        <button type="button" disabled={pending} onClick={onClear}>
          Clear selection
        </button>
      </div>
    </section>
  );
}
