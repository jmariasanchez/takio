import {
  FORMAT_CATALOG,
  type BookFormat,
  type Destination,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import type {
  LibraryFacetCounts,
  LibraryMetadataPatch,
  LibraryQueryFilters,
  LibraryQuerySort,
  SavedLibraryView,
} from "@takio/library-contract";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";

import type { ConversionChoice } from "../lib/conversion-choices";
import {
  resolveDeviceFormatPreference,
  type DeviceFormatPreference,
} from "../lib/device-format-preference";
import {
  draftFor as metadataDraftFor,
  type MetadataDraft as EditorMetadataDraft,
} from "../lib/metadata-draft";
import { LibraryFacetSidebar } from "./LibraryFacetSidebar";
import type { DuplicateReviewDisposition } from "./LibraryDuplicateReviewDialog";
import {
  LibraryBulkActionBar,
  type LibraryBulkPendingAction,
} from "./LibraryBulkActionBar";
import {
  LibraryExportDialog,
  type LibraryExportFileNameTemplate,
} from "./LibraryExportDialog";
import { LibraryBulkMetadataDialog } from "./LibraryBulkMetadataDialog";
import {
  LibraryBulkTagsDialog,
  type LibraryBulkTagsOperation,
} from "./LibraryBulkTagsDialog";
import {
  LibraryInspector,
  libraryOpenControlId,
} from "./LibraryInspector";
import { LibraryTable } from "./LibraryTable";
import { LibraryWorkspaceLayout } from "./LibraryWorkspaceLayout";
import { MetadataEditor } from "./MetadataEditor";
import { SaveLibraryViewDialog } from "./SaveLibraryViewDialog";
import {
  compactFacetsTriggerId,
  type CompactPane,
} from "./CompactPaneDrawer";
import "./LibraryWorkspace.css";

export type LibraryState = "loading" | "ready" | "error";
export type MetadataDraft = EditorMetadataDraft & { readonly id: string };
export type ConversionDraft = {
  readonly id: string;
  readonly source: BookFormat;
  readonly target: FormatId;
};
export type GeneralSendResolution =
  | DeviceFormatPreference
  | { readonly kind: "no-preference" };

export function resolveGeneralSend(
  formats: readonly BookFormat[],
  preferredFormat: FormatId | null,
): GeneralSendResolution {
  return preferredFormat === null
    ? { kind: "no-preference" }
    : resolveDeviceFormatPreference(formats, preferredFormat);
}

export type LibraryWorkspaceBulkActions = {
  readonly pendingAction: LibraryBulkPendingAction | null;
  readonly canConvert: boolean;
  readonly canSend: boolean;
  readonly exportDialogOpen: boolean;
  readonly exportSelectedCount: number;
  readonly tagsDialogOpen: boolean;
  readonly tagsDialogError: string | null;
  readonly metadataDialogOpen: boolean;
  readonly metadataDialogError: string | null;
  readonly onExport: () => void;
  readonly onEditTags: () => void;
  readonly onEditMetadata: () => void;
  readonly onConvert: () => void;
  readonly onSend: () => void;
  readonly onMoveToTrash: () => void;
  readonly onClearSelection: () => void;
  readonly onCloseTagsDialog: () => void;
  readonly onCloseMetadataDialog: () => void;
  readonly onCloseExportDialog: () => void;
  readonly onConfirmExport: (template: LibraryExportFileNameTemplate) => void;
  readonly onApplyTags: (
    operation: LibraryBulkTagsOperation,
    tags: readonly string[],
  ) => void;
  readonly onApplyMetadata: (patch: LibraryMetadataPatch) => void;
};

export type LibraryWorkspaceProps = {
  readonly actionsPending: boolean;
  readonly bulkActions?: LibraryWorkspaceBulkActions;
  readonly conversionDraft: ConversionDraft | null;
  readonly currentSavedViewId: string | null;
  readonly draft: MetadataDraft | null;
  readonly facets: LibraryFacetCounts;
  readonly filters: LibraryQueryFilters;
  readonly items: readonly LibraryItem[];
  readonly libraryState: LibraryState;
  readonly pageLimit: number;
  readonly pageOffset: number;
  readonly pendingAction: string | null;
  readonly preferredDeviceFormat: FormatId | null;
  readonly query: string;
  readonly savedViews: readonly SavedLibraryView[];
  readonly saveViewDialogBusy: boolean;
  readonly saveViewDialogError: string | null;
  readonly saveViewDialogOpen: boolean;
  readonly saveViewSuggestedName: string;
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly searchPending: boolean;
  readonly selectedDestination: Destination | null;
  readonly selectedItemId: string | null;
  readonly selectedItemIds: readonly string[];
  readonly sort: LibraryQuerySort;
  readonly total: number;
  readonly onApplySavedView: (id: string) => void;
  readonly onAttachFormat: (
    item: LibraryItem,
    mode: "copy" | "reference",
    focusControlId: string,
  ) => Promise<void>;
  readonly onCancelSaveView: () => void;
  readonly onChangeFilters: (filters: LibraryQueryFilters) => void;
  readonly onChangePage: (offset: number) => void;
  readonly onChangeSearch: (query: string) => void;
  readonly onChangeSort: (sort: LibraryQuerySort) => void;
  readonly onChooseCover: (item: LibraryItem) => Promise<void>;
  readonly onClearAll: () => void;
  readonly onClearCover: (item: LibraryItem) => Promise<void>;
  readonly onEnqueueConversion: (event: FormEvent, item: LibraryItem) => Promise<void>;
  readonly onOpenItem: (
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ) => Promise<void>;
  readonly onOpenDuplicateReview: (disposition: DuplicateReviewDisposition) => void;
  readonly onOpenImport?: () => void;
  readonly onOpenSaveView: () => void;
  readonly onOpenTrash: () => void;
  readonly onRemoveFormat: (
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ) => Promise<void>;
  readonly onRemoveItem: (item: LibraryItem) => Promise<void>;
  readonly onRemoveSavedView: (id: string) => void;
  readonly onRetry: () => Promise<boolean>;
  readonly onSaveMetadata: (
    item: LibraryItem,
    patch: LibraryMetadataPatch,
  ) => Promise<void>;
  readonly onSaveView: (name: string) => void;
  readonly onSelectItem: (id: string) => void;
  readonly onSelectItemRange: (id: string, pageItemIds: readonly string[]) => void;
  readonly onSendItem: (item: LibraryItem, bookFormat: BookFormat) => Promise<void>;
  readonly onSetConversionDraft: (draft: ConversionDraft | null) => void;
  readonly onSetDraft: (draft: MetadataDraft | null) => void;
  readonly onTogglePageSelection: (pageItemIds: readonly string[]) => void;
  readonly onToggleSelectedItem: (id: string) => void;
};

function formatLabel(format: FormatId): string {
  return FORMAT_CATALOG.find(({ id }) => id === format)?.label ?? format.toUpperCase();
}

function metadataDraft(item: LibraryItem): MetadataDraft {
  return { id: item.id, ...metadataDraftFor(item) };
}

function hasActiveFilters(filters: LibraryQueryFilters): boolean {
  return Object.values(filters).some((values) => values.length > 0);
}

export { conversionControlId } from "./LibraryInspector";

export function openSaveViewWithPaneClosed(
  closePane: (pane: CompactPane | null) => void,
  openSaveView: () => void,
): void {
  closePane(null);
  openSaveView();
}

export function openTrashDialog(onOpenTrash: () => void): void {
  onOpenTrash();
}

export function openDuplicateReviewDialog(
  disposition: DuplicateReviewDisposition,
  onOpenDuplicateReview: (disposition: DuplicateReviewDisposition) => void,
): void {
  onOpenDuplicateReview(disposition);
}

type FocusTarget = { focus: () => void };

export function restoreSaveViewDialogFocus(
  wasOpen: boolean,
  open: boolean,
  compactFacetsTrigger: FocusTarget | null,
  desktopFallback: FocusTarget | null,
): boolean {
  if (!wasOpen || open) {
    return false;
  }

  (compactFacetsTrigger ?? desktopFallback)?.focus();
  return true;
}

function InspectorManagement({
  actionsPending,
  conversionDraft,
  draft,
  item,
  pendingAction,
  preferredDeviceFormat,
  selectedDestination,
  onAttachFormat,
  onChooseCover,
  onClearCover,
  onEnqueueConversion,
  onOpenItem,
  onRemoveFormat,
  onRemoveItem,
  onSaveMetadata,
  onSendItem,
  onSetConversionDraft,
  onSetDraft,
}: Readonly<{
  actionsPending: boolean;
  conversionDraft: ConversionDraft | null;
  draft: MetadataDraft | null;
  item: LibraryItem | null;
  pendingAction: string | null;
  preferredDeviceFormat: FormatId | null;
  selectedDestination: Destination | null;
  onAttachFormat: LibraryWorkspaceProps["onAttachFormat"];
  onChooseCover: LibraryWorkspaceProps["onChooseCover"];
  onClearCover: LibraryWorkspaceProps["onClearCover"];
  onEnqueueConversion: LibraryWorkspaceProps["onEnqueueConversion"];
  onOpenItem: LibraryWorkspaceProps["onOpenItem"];
  onRemoveFormat: LibraryWorkspaceProps["onRemoveFormat"];
  onRemoveItem: LibraryWorkspaceProps["onRemoveItem"];
  onSaveMetadata: LibraryWorkspaceProps["onSaveMetadata"];
  onSendItem: LibraryWorkspaceProps["onSendItem"];
  onSetConversionDraft: LibraryWorkspaceProps["onSetConversionDraft"];
  onSetDraft: LibraryWorkspaceProps["onSetDraft"];
}>) {
  if (!item) {
    return (
      <LibraryInspector
        actionsDisabled={actionsPending}
        item={null}
        onConvertFormat={() => undefined}
        onOpenFormat={() => undefined}
        onSendFormat={() => undefined}
      />
    );
  }

  const editing = draft?.id === item.id;
  const activeConversion = conversionDraft?.id === item.id ? conversionDraft : null;
  const preferredResolution = resolveGeneralSend(item.formats, preferredDeviceFormat);
  const preferredLabel =
    preferredDeviceFormat === null ? null : formatLabel(preferredDeviceFormat);

  function chooseConversion(selectedItem: LibraryItem, choice: ConversionChoice): void {
    onSetDraft(null);
    onSetConversionDraft({
      id: selectedItem.id,
      source: choice.source,
      target: choice.target,
    });
  }

  function openFormat(selectedItem: LibraryItem, bookFormat: BookFormat): void {
    void onOpenItem(
      selectedItem,
      bookFormat,
      libraryOpenControlId(selectedItem, bookFormat),
    );
  }

  function sendFormat(selectedItem: LibraryItem, bookFormat: BookFormat): void {
    if (selectedDestination) void onSendItem(selectedItem, bookFormat);
  }

  return (
    <div className="library-workspace__inspector-stack">
      {editing && draft ? (
        <MetadataEditor
          busy={pendingAction === `edit:${item.id}`}
          disabled={actionsPending}
          draft={draft}
          idPrefix={`metadata-${item.id}`}
          onCancel={() => onSetDraft(null)}
          onChange={(nextDraft) => onSetDraft({ id: item.id, ...nextDraft })}
          onSave={(patch) => void onSaveMetadata(item, patch)}
        />
      ) : (
        <>
          <LibraryInspector
            actionsDisabled={actionsPending}
            item={item}
            onConvertFormat={chooseConversion}
            onOpenFormat={openFormat}
            onSendFormat={sendFormat}
          />

          <section
            className="library-workspace__management"
            aria-labelledby={`library-management-${item.id}`}
          >
            <div className="library-workspace__management-heading">
              <h3 id={`library-management-${item.id}`}>Manage</h3>
              <button
                type="button"
                disabled={actionsPending}
                onClick={() => {
                  onSetConversionDraft(null);
                  onSetDraft(metadataDraft(item));
                }}
              >
                Edit metadata
              </button>
            </div>

            <div className="library-workspace__action-grid">
              <button
                type="button"
                id={`format-import-copy-${item.id}`}
                disabled={actionsPending}
                onClick={(event) =>
                  void onAttachFormat(item, "copy", event.currentTarget.id)
                }
              >
                {pendingAction === `format-attach:${item.id}:copy`
                  ? "Importing…"
                  : "Import a copy…"}
              </button>
              <button
                type="button"
                id={`format-attach-reference-${item.id}`}
                disabled={actionsPending}
                onClick={(event) =>
                  void onAttachFormat(item, "reference", event.currentTarget.id)
                }
              >
                {pendingAction === `format-attach:${item.id}:reference`
                  ? "Attaching…"
                  : "Attach a reference…"}
              </button>
              <button
                type="button"
                disabled={actionsPending}
                onClick={() => void onChooseCover(item)}
              >
                {pendingAction === `cover:${item.id}` ? "Updating…" : "Choose cover…"}
              </button>
              {item.coverPath ? (
                <button
                  type="button"
                  disabled={actionsPending}
                  onClick={() => void onClearCover(item)}
                >
                  Remove cover
                </button>
              ) : null}
            </div>

            <div className="library-workspace__preferred-send">
              <span>Reader format</span>
              <button
                type="button"
                aria-label={
                  !selectedDestination
                    ? `Choose a reader before sending “${item.title}”`
                    : preferredResolution.kind === "no-preference"
                      ? `Choose a session send format for “${item.title}”`
                      : preferredResolution.kind === "attached"
                        ? `Send ${preferredLabel} for “${item.title}” to ${selectedDestination.name}`
                        : preferredResolution.kind === "convertible"
                          ? `Convert ${preferredResolution.source.format.toUpperCase()} to ${preferredLabel} for “${item.title}” before sending to ${selectedDestination.name}`
                          : `${preferredLabel} is unavailable for “${item.title}”`
                }
                disabled={
                  actionsPending ||
                  !selectedDestination ||
                  preferredResolution.kind === "no-preference" ||
                  preferredResolution.kind === "unavailable"
                }
                onClick={() => {
                  if (preferredResolution.kind === "attached") {
                    void onSendItem(item, preferredResolution.bookFormat);
                  } else if (preferredResolution.kind === "convertible") {
                    onSetDraft(null);
                    onSetConversionDraft({
                      id: item.id,
                      source: preferredResolution.source,
                      target: preferredResolution.target,
                    });
                  }
                }}
              >
                {preferredResolution.kind === "attached" &&
                pendingAction ===
                  `send:${item.id}:${preferredResolution.bookFormat.format}`
                  ? "Sending…"
                  : !selectedDestination
                    ? "Send"
                    : preferredResolution.kind === "no-preference"
                      ? "Choose format"
                      : preferredResolution.kind === "attached"
                        ? `Send ${preferredLabel}`
                        : preferredResolution.kind === "convertible"
                          ? `Convert to ${preferredLabel}`
                          : `${preferredLabel} unavailable`}
              </button>
            </div>

            <div className="library-workspace__format-removal">
              <span>Attached formats</span>
              <ul>
                {item.formats.map((bookFormat) => {
                  const label = formatLabel(bookFormat.format);
                  const lastFormat = item.formats.length === 1;
                  const removeId = `format-remove-${item.id}-${bookFormat.format}`;
                  return (
                    <li key={bookFormat.format}>
                      <span>{label}</span>
                      <button
                        type="button"
                        id={removeId}
                        aria-label={`${
                          bookFormat.provenance === "managed"
                            ? "Delete managed copy"
                            : "Detach reference"
                        } for ${label} from “${item.title}”`}
                        disabled={actionsPending || lastFormat}
                        onClick={() => void onRemoveFormat(item, bookFormat, removeId)}
                      >
                        {pendingAction ===
                        `format-remove:${item.id}:${bookFormat.format}`
                          ? bookFormat.provenance === "managed"
                            ? "Deleting…"
                            : "Detaching…"
                          : bookFormat.provenance === "managed"
                            ? "Delete copy"
                            : "Detach"}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {item.formats.length === 1 ? (
                <small>Add another format before removing the last one.</small>
              ) : null}
            </div>

            <button
              type="button"
              className="library-workspace__remove-item"
              disabled={actionsPending}
              onClick={() => void onRemoveItem(item)}
            >
              {pendingAction === `remove:${item.id}` ? "Moving to Trash…" : "Move to Trash"}
            </button>
          </section>

          {activeConversion ? (
            <form
              className="library-workspace__conversion"
              id={`conversion-${item.id}`}
              aria-labelledby={`conversion-heading-${item.id}`}
              onSubmit={(event) => void onEnqueueConversion(event, item)}
            >
              <div>
                <strong id={`conversion-heading-${item.id}`}>
                  Convert {formatLabel(activeConversion.source.format)} to{" "}
                  {formatLabel(activeConversion.target)}
                </strong>
                <span>Choose where to save the converted file, then run it from the queue.</span>
              </div>
              <div className="library-workspace__conversion-actions">
                <button
                  type="button"
                  disabled={actionsPending}
                  onClick={() => onSetConversionDraft(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id={`conversion-format-${item.id}`}
                  disabled={actionsPending}
                >
                  {pendingAction === `job-enqueue:${item.id}` ? "Queueing…" : "Choose output…"}
                </button>
              </div>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

export function LibraryWorkspace({
  actionsPending,
  bulkActions,
  conversionDraft,
  currentSavedViewId,
  draft,
  facets,
  filters,
  items,
  libraryState,
  pageLimit,
  pageOffset,
  pendingAction,
  preferredDeviceFormat,
  query,
  savedViews,
  saveViewDialogBusy,
  saveViewDialogError,
  saveViewDialogOpen,
  saveViewSuggestedName,
  searchInput,
  searchPending,
  selectedDestination,
  selectedItemId,
  selectedItemIds,
  sort,
  total,
  onApplySavedView,
  onAttachFormat,
  onCancelSaveView,
  onChangeFilters,
  onChangePage,
  onChangeSearch,
  onChangeSort,
  onChooseCover,
  onClearAll,
  onClearCover,
  onEnqueueConversion,
  onOpenDuplicateReview,
  onOpenImport,
  onOpenItem,
  onOpenSaveView,
  onOpenTrash,
  onRemoveFormat,
  onRemoveItem,
  onRemoveSavedView,
  onRetry,
  onSaveMetadata,
  onSaveView,
  onSelectItem,
  onSelectItemRange,
  onSendItem,
  onSetConversionDraft,
  onSetDraft,
  onTogglePageSelection,
  onToggleSelectedItem,
}: LibraryWorkspaceProps) {
  const [openPane, setOpenPane] = useState<CompactPane | null>(null);
  const previousSaveViewDialogOpen = useRef(saveViewDialogOpen);
  const selectedItem = items.find(({ id }) => id === selectedItemId) ?? null;
  const busy = libraryState === "loading" || searchPending;
  const interactionsDisabled = busy || actionsPending;
  const filtered = query.trim() !== "" || hasActiveFilters(filters);
  const firstUse = libraryState === "ready" && !busy && total === 0 && !filtered;

  useEffect(() => {
    if (conversionDraft !== null) {
      setOpenPane("inspector");
    }
  }, [conversionDraft]);

  useEffect(() => {
    const wasOpen = previousSaveViewDialogOpen.current;
    previousSaveViewDialogOpen.current = saveViewDialogOpen;
    if (!wasOpen || saveViewDialogOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      restoreSaveViewDialogFocus(
        wasOpen,
        saveViewDialogOpen,
        document.getElementById(compactFacetsTriggerId),
        searchInput.current,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [saveViewDialogOpen, searchInput]);

  const facetSidebar = (
    <LibraryFacetSidebar
      currentSavedViewId={currentSavedViewId}
      facets={facets}
      filters={filters}
      savedViews={savedViews}
      onApplySavedView={onApplySavedView}
      onChangeFilters={onChangeFilters}
      onClearAll={onClearAll}
      onRemoveSavedView={onRemoveSavedView}
      onSaveSavedView={() =>
        openSaveViewWithPaneClosed(setOpenPane, onOpenSaveView)
      }
    />
  );
  const inspector = (
    <InspectorManagement
      actionsPending={actionsPending}
      conversionDraft={conversionDraft}
      draft={draft}
      item={selectedItem}
      pendingAction={pendingAction}
      preferredDeviceFormat={preferredDeviceFormat}
      selectedDestination={selectedDestination}
      onAttachFormat={onAttachFormat}
      onChooseCover={onChooseCover}
      onClearCover={onClearCover}
      onEnqueueConversion={onEnqueueConversion}
      onOpenItem={onOpenItem}
      onRemoveFormat={onRemoveFormat}
      onRemoveItem={onRemoveItem}
      onSaveMetadata={onSaveMetadata}
      onSendItem={onSendItem}
      onSetConversionDraft={onSetConversionDraft}
      onSetDraft={onSetDraft}
    />
  );

  const toolbar = (
    <div className="library-workspace__toolbar">
      <div className="library-workspace__title">
        <div>
          <span>Library</span>
          <h2>All books</h2>
        </div>
        <span className="library-workspace__count">
          {busy
            ? "Updating…"
            : `${total.toLocaleString()} ${total === 1 ? "book" : "books"}`}
        </span>
      </div>
      <div className="library-workspace__toolbar-actions">
        <label className="library-workspace__search" htmlFor="library-search">
          <span className="visually-hidden">Search library</span>
          <input
            ref={searchInput}
            id="library-search"
            type="search"
            value={query}
            disabled={actionsPending || firstUse}
            placeholder="Search your library"
            onChange={(event) => onChangeSearch(event.currentTarget.value)}
          />
        </label>
        <details className="library-workspace__more">
          <summary aria-label="Library tools">Library tools</summary>
          <div className="library-workspace__maintenance-actions">
            <button
              id="library-duplicates-trigger"
              className="library-workspace__maintenance-button"
              type="button"
              aria-haspopup="dialog"
              disabled={actionsPending}
              onClick={() => openDuplicateReviewDialog("unreviewed", onOpenDuplicateReview)}
            >
              Review duplicates…
            </button>
            <button
              id="library-kept-duplicates-trigger"
              className="library-workspace__maintenance-button"
              type="button"
              aria-haspopup="dialog"
              disabled={actionsPending}
              onClick={() => openDuplicateReviewDialog("kept-both", onOpenDuplicateReview)}
            >
              Kept separate…
            </button>
            <button
              id="library-trash-trigger"
              className="library-workspace__maintenance-button"
              type="button"
              aria-haspopup="dialog"
              disabled={actionsPending}
              onClick={() => openTrashDialog(onOpenTrash)}
            >
              Trash
            </button>
          </div>
        </details>
      </div>
    </div>
  );

  if (firstUse) {
    return (
      <div className="library-workspace" aria-busy={busy}>
        {toolbar}
        <main className="library-workspace__first-use" aria-labelledby="library-first-use-title">
          <div className="library-workspace__first-use-card">
            <span className="library-workspace__first-use-kicker">Start your library</span>
            <h2 id="library-first-use-title">Add your first books to Takio</h2>
            <p>
              Bring in ebooks and documents, then browse, search, edit metadata, and send
              them to your reader from one catalogue.
            </p>
            <button
              type="button"
              className="library-workspace__first-use-action"
              disabled={actionsPending || !onOpenImport}
              onClick={onOpenImport}
            >
              Add books
            </button>
            <div className="library-workspace__first-use-drop">
              <strong>Drop files anywhere in this window</strong>
              <span>Takio will import supported files and skip anything it cannot read.</span>
            </div>
            <dl className="library-workspace__first-use-facts">
              <div>
                <dt>Formats</dt>
                <dd>
                  EPUB, PDF, MOBI, AZW3, CBZ, CBR, TXT, HTML, and common ebook
                  documents.
                </dd>
              </div>
              <div>
                <dt>Your files</dt>
                <dd>
                  Copy into Takio, move into the library, or keep references to files
                  where they are.
                </dd>
              </div>
            </dl>
          </div>
        </main>
      </div>
    );
  }

  return (
    <>
      <div className="library-workspace" aria-busy={busy}>
        <LibraryWorkspaceLayout
          facets={facetSidebar}
          inspector={inspector}
          openPane={openPane}
          toolbar={toolbar}
          table={
            <>
              {bulkActions ? (
                <LibraryBulkActionBar
                  selectedCount={selectedItemIds.length}
                  disabled={actionsPending}
                  pendingAction={bulkActions.pendingAction}
                  canConvert={bulkActions.canConvert}
                  canSend={bulkActions.canSend}
                  exportDialogOpen={bulkActions.exportDialogOpen}
                  onExport={bulkActions.onExport}
                  onEditTags={bulkActions.onEditTags}
                  onEditMetadata={bulkActions.onEditMetadata}
                  onConvert={bulkActions.onConvert}
                  onSend={bulkActions.onSend}
                  onMoveToTrash={bulkActions.onMoveToTrash}
                  onClear={bulkActions.onClearSelection}
                />
              ) : null}
              <div className="library-workspace__results">
              {busy && libraryState !== "error" && items.length === 0 ? (
                <div className="library-workspace__state" role="status">
                  Loading your library…
                </div>
              ) : null}
              {libraryState === "error" ? (
                <div className="library-workspace__state library-workspace__state--error">
                  <strong>Library unavailable</strong>
                  <span>Takio could not load the files stored on this device.</span>
                  <button
                    type="button"
                    disabled={actionsPending}
                    onClick={() => void onRetry()}
                  >
                    Try again
                  </button>
                </div>
              ) : null}
              {libraryState === "ready" && !busy && items.length === 0 ? (
                <div className="library-workspace__state">
                  <strong>No matches</strong>
                  <span>
                    Try a different search or clear the active filters.
                  </span>
                  {filtered ? (
                    <button type="button" onClick={onClearAll}>
                      Clear search and filters
                    </button>
                  ) : null}
                </div>
              ) : null}
              {libraryState !== "error" ? (
                <LibraryTable
                  busy={interactionsDisabled}
                  items={items}
                  pageLimit={pageLimit}
                  pageOffset={pageOffset}
                  selectedItemId={selectedItemId}
                  selectedItemIds={selectedItemIds}
                  sort={sort}
                  total={total}
                  onChangePage={onChangePage}
                  onChangeSort={onChangeSort}
                  onOpenItem={(item) => {
                    const primaryFormat = item.formats[0];
                    if (primaryFormat) {
                      void onOpenItem(
                        item,
                        primaryFormat,
                        `library-item-${item.id}`,
                      );
                    }
                  }}
                  onSelectRange={onSelectItemRange}
                  onSelectItem={onSelectItem}
                  onToggleItem={onToggleSelectedItem}
                  onTogglePage={onTogglePageSelection}
                />
              ) : null}
              </div>
            </>
          }
          onOpenPaneChange={setOpenPane}
        />
      </div>

      <SaveLibraryViewDialog
        busy={saveViewDialogBusy}
        error={saveViewDialogError}
        open={saveViewDialogOpen}
        suggestedName={saveViewSuggestedName}
        onCancel={onCancelSaveView}
        onSave={onSaveView}
      />

      {bulkActions ? (
        <>
          <LibraryExportDialog
            open={bulkActions.exportDialogOpen}
            selectedCount={bulkActions.exportSelectedCount}
            pending={bulkActions.pendingAction === "export"}
            onClose={bulkActions.onCloseExportDialog}
            onConfirm={bulkActions.onConfirmExport}
          />
          <LibraryBulkTagsDialog
            open={bulkActions.tagsDialogOpen}
            selectedCount={selectedItemIds.length}
            pending={bulkActions.pendingAction === "tags"}
            error={bulkActions.tagsDialogError}
            onClose={bulkActions.onCloseTagsDialog}
            onApply={bulkActions.onApplyTags}
          />
          <LibraryBulkMetadataDialog
            open={bulkActions.metadataDialogOpen}
            selectedCount={selectedItemIds.length}
            pending={bulkActions.pendingAction === "metadata"}
            error={bulkActions.metadataDialogError}
            onClose={bulkActions.onCloseMetadataDialog}
            onApply={bulkActions.onApplyMetadata}
          />
        </>
      ) : null}
    </>
  );
}
