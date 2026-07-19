import type { FormEvent, RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  FORMAT_CATALOG,
  type BookFormat,
  type Destination,
  type LibraryItem,
} from "@takio/core";

export type LibraryState = "loading" | "ready" | "error";
export type MetadataDraft = {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly description: string;
  readonly tags: string;
};
export type ConversionDraft = { readonly id: string };

type LibraryWorkspaceProps = {
  readonly actionsPending: boolean;
  readonly conversionDraft: ConversionDraft | null;
  readonly draft: MetadataDraft | null;
  readonly items: readonly LibraryItem[];
  readonly libraryState: LibraryState;
  readonly pendingAction: string | null;
  readonly query: string;
  readonly searchInput: RefObject<HTMLInputElement | null>;
  readonly searchPending: boolean;
  readonly selectedDestination: Destination | null;
  readonly selectedItemId: string | null;
  readonly onAttachFormat: (
    item: LibraryItem,
    mode: "copy" | "reference",
    focusControlId: string,
  ) => Promise<void>;
  readonly onChangeSearch: (query: string) => void;
  readonly onChooseCover: (item: LibraryItem) => Promise<void>;
  readonly onClearCover: (item: LibraryItem) => Promise<void>;
  readonly onEnqueueConversion: (event: FormEvent, item: LibraryItem) => Promise<void>;
  readonly onOpenItem: (
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ) => Promise<void>;
  readonly onRemoveFormat: (
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ) => Promise<void>;
  readonly onRemoveItem: (item: LibraryItem) => Promise<void>;
  readonly onRetry: () => Promise<boolean>;
  readonly onSaveMetadata: (event: FormEvent, item: LibraryItem) => Promise<void>;
  readonly onSelectItem: (id: string) => void;
  readonly onSendItem: (item: LibraryItem) => Promise<void>;
  readonly onSetConversionDraft: (draft: ConversionDraft | null) => void;
  readonly onSetDraft: (draft: MetadataDraft | null) => void;
};

function addedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function draftFor(item: LibraryItem): MetadataDraft {
  return {
    id: item.id,
    title: item.title,
    author: item.author ?? "",
    description: item.description ?? "",
    tags: item.tags.join(", "),
  };
}

export function LibraryWorkspace({
  actionsPending,
  conversionDraft,
  draft,
  items,
  libraryState,
  pendingAction,
  query,
  searchInput,
  searchPending,
  selectedDestination,
  selectedItemId,
  onAttachFormat,
  onChangeSearch,
  onChooseCover,
  onClearCover,
  onEnqueueConversion,
  onOpenItem,
  onRemoveFormat,
  onRemoveItem,
  onRetry,
  onSaveMetadata,
  onSelectItem,
  onSendItem,
  onSetConversionDraft,
  onSetDraft,
}: LibraryWorkspaceProps) {
  return (
    <section
      className="library-section"
      aria-busy={libraryState === "loading" || searchPending}
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">FILES</p>
          <h2>Your library</h2>
        </div>
        {libraryState === "ready" && (
          <span className="item-count">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        )}
      </div>

      <label className="search-field" htmlFor="library-search">
        <span>Search your library</span>
        <input
          ref={searchInput}
          id="library-search"
          type="search"
          value={query}
          onChange={(event) => onChangeSearch(event.currentTarget.value)}
          placeholder="Title, author, description, or tag"
        />
      </label>

      {libraryState === "loading" && <div className="state-panel">Loading your library…</div>}

      {libraryState === "error" && items.length === 0 && (
        <div className="state-panel error-panel">
          <strong>Library unavailable</strong>
          <span>Takio could not load the files stored on this device.</span>
          <button
            className="quiet-button"
            disabled={actionsPending}
            onClick={() => void onRetry()}
          >
            Try again
          </button>
        </div>
      )}

      {libraryState === "ready" && items.length === 0 && (
        <div className="state-panel">
          <strong>{query === "" ? "No files yet" : "No matches"}</strong>
          <span>
            {query === ""
              ? "Choose a supported book or document to start your local library."
              : "Try a different title, author, description, or tag."}
          </span>
        </div>
      )}

      {items.length > 0 && (
        <div className="book-list">
          {items.map((item) => {
            const editing = draft?.id === item.id;
            const converting = conversionDraft?.id === item.id;
            const selected = selectedItemId === item.id;
            return (
              <article
                className={`book-card${selected ? " selected" : ""}`}
                id={`library-item-${item.id}`}
                key={item.id}
                tabIndex={0}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectItem(item.id)}
                onFocus={() => onSelectItem(item.id)}
              >
                <div className="book-row">
                  {item.coverPath ? (
                    <img
                      className="cover cover-image"
                      src={convertFileSrc(item.coverPath)}
                      alt={`Cover for ${item.title}`}
                    />
                  ) : (
                    <div className="cover" aria-hidden="true">
                      {item.title.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="book-title">
                    <strong>{item.title}</strong>
                    <span>
                      {item.author ? `${item.author} · ` : ""}
                      {item.formats
                        .map(
                          ({ format, provenance }) =>
                            `${
                              FORMAT_CATALOG.find(
                                (definition) => definition.id === format,
                              )!.label
                            } (${provenance === "managed" ? "Managed copy" : "External reference"})`,
                        )
                        .join(", ")} · Added {addedDate(item.addedAt)}
                    </span>
                    {item.tags.length > 0 && (
                      <span className="tag-summary">{item.tags.join(" · ")}</span>
                    )}
                    {selected && <span className="selection-label">Selected</span>}
                  </div>
                  <div className="row-actions">
                    <button
                      className="row-button"
                      id={`library-primary-open-${item.id}`}
                      aria-label={`Open ${
                        FORMAT_CATALOG.find(
                          (definition) => definition.id === item.formats[0].format,
                        )!.label
                      } for “${item.title}” in your default app`}
                      disabled={actionsPending}
                      onClick={(event) =>
                        void onOpenItem(item, item.formats[0], event.currentTarget.id)
                      }
                    >
                      {pendingAction === `open:${item.id}:${item.formats[0].format}`
                        ? "Opening…"
                        : "Open"}
                    </button>
                    <button
                      className="row-button send-button"
                      aria-label={`Send ${item.title} to the selected reader`}
                      disabled={actionsPending || !selectedDestination}
                      onClick={() => void onSendItem(item)}
                    >
                      {pendingAction === `send:${item.id}` ? "Sending…" : "Send"}
                    </button>
                    {item.format === "epub" && (
                      <button
                        className="row-button"
                        aria-label={
                          converting
                            ? `Cancel conversion for ${item.title}`
                            : `Convert ${item.title}`
                        }
                        aria-expanded={converting}
                        aria-controls={`conversion-${item.id}`}
                        disabled={actionsPending}
                        onClick={() => {
                          onSetDraft(null);
                          onSetConversionDraft(converting ? null : { id: item.id });
                        }}
                      >
                        {converting ? "Cancel convert" : "Convert"}
                      </button>
                    )}
                    <button
                      className="row-button"
                      aria-expanded={editing}
                      aria-controls={`edit-${item.id}`}
                      disabled={actionsPending}
                      onClick={() => {
                        onSetConversionDraft(null);
                        onSetDraft(editing ? null : draftFor(item));
                      }}
                    >
                      {editing ? "Cancel edit" : "Edit"}
                    </button>
                    <button
                      className="row-button danger-button"
                      aria-label={`Remove ${item.title}`}
                      disabled={actionsPending}
                      onClick={() => void onRemoveItem(item)}
                    >
                      {pendingAction === `remove:${item.id}` ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>

                {selected && (
                  <section
                    className="format-panel"
                    aria-labelledby={`formats-heading-${item.id}`}
                    aria-busy={
                      pendingAction?.startsWith(`open:${item.id}:`) ||
                      pendingAction?.startsWith(`format-attach:${item.id}:`) ||
                      pendingAction?.startsWith(`format-remove:${item.id}:`)
                    }
                  >
                    <div className="format-panel-heading">
                      <div className="format-panel-title">
                        <h3 id={`formats-heading-${item.id}`}>Formats</h3>
                        <span>
                          {item.formats.length} {item.formats.length === 1 ? "format" : "formats"}
                        </span>
                      </div>
                      <div className="format-panel-actions">
                        <button
                          type="button"
                          className="quiet-button"
                          id={`format-import-copy-${item.id}`}
                          aria-label={`Import a managed format copy for “${item.title}”`}
                          disabled={actionsPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            void onAttachFormat(item, "copy", event.currentTarget.id);
                          }}
                        >
                          {pendingAction === `format-attach:${item.id}:copy`
                            ? "Importing…"
                            : "Import a copy…"}
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          id={`format-attach-reference-${item.id}`}
                          aria-label={`Attach an external format reference for “${item.title}”`}
                          disabled={actionsPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            void onAttachFormat(item, "reference", event.currentTarget.id);
                          }}
                        >
                          {pendingAction === `format-attach:${item.id}:reference`
                            ? "Attaching…"
                            : "Attach a reference…"}
                        </button>
                      </div>
                    </div>
                    <ol className="format-list" role="list">
                      {item.formats.map((bookFormat, index) => {
                        const label = FORMAT_CATALOG.find(
                          (definition) => definition.id === bookFormat.format,
                        )!.label;
                        return (
                          <li className="format-row" key={bookFormat.format}>
                            <div className="format-name">
                              <strong>{label}</strong>
                              {index === 0 && <span className="format-default">Primary format</span>}
                            </div>
                            <span>
                              {bookFormat.provenance === "managed"
                                ? "Managed copy"
                                : "External reference"}
                              {` · Added ${addedDate(bookFormat.addedAt)}`}
                            </span>
                            <code>
                              {bookFormat.provenance === "managed"
                                ? "Stored in Takio library"
                                : bookFormat.sourcePath}
                            </code>
                            <div className="format-row-actions">
                              <button
                                type="button"
                                className="quiet-button"
                                id={`format-open-${item.id}-${bookFormat.format}`}
                                aria-label={`Open ${label} for “${item.title}” in your default app`}
                                disabled={actionsPending}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void onOpenItem(item, bookFormat, event.currentTarget.id);
                                }}
                              >
                                {pendingAction === `open:${item.id}:${bookFormat.format}`
                                  ? "Opening…"
                                  : "Open"}
                              </button>
                              <button
                                type="button"
                                className={`quiet-button format-remove-button${
                                  item.formats.length === 1 ? " format-last-button" : ""
                                }`}
                                id={`format-remove-${item.id}-${bookFormat.format}`}
                                aria-label={`${
                                  bookFormat.provenance === "managed"
                                    ? "Delete managed copy"
                                    : "Detach reference"
                                } for ${label} from “${item.title}”`}
                                aria-describedby={
                                  item.formats.length === 1
                                    ? `last-format-help-${item.id}-${bookFormat.format}`
                                    : undefined
                                }
                                disabled={actionsPending || item.formats.length === 1}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void onRemoveFormat(item, bookFormat, event.currentTarget.id);
                                }}
                              >
                                {pendingAction ===
                                `format-remove:${item.id}:${bookFormat.format}`
                                  ? bookFormat.provenance === "managed"
                                    ? "Deleting…"
                                    : "Detaching…"
                                  : bookFormat.provenance === "managed"
                                    ? "Delete managed copy"
                                    : "Detach reference"}
                              </button>
                              {item.formats.length === 1 && (
                                <small
                                  className="format-last-help"
                                  id={`last-format-help-${item.id}-${bookFormat.format}`}
                                >
                                  Add another format before removing this one.
                                </small>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                )}

                {converting && (
                  <form
                    className="conversion-panel"
                    id={`conversion-${item.id}`}
                    aria-labelledby={`conversion-heading-${item.id}`}
                    onSubmit={(event) => void onEnqueueConversion(event, item)}
                  >
                    <div className="conversion-copy">
                      <strong id={`conversion-heading-${item.id}`}>Convert EPUB</strong>
                      <span id={`conversion-help-${item.id}`}>
                        Choose where to save the PDF, then run it from the queue.
                      </span>
                    </div>
                    <label htmlFor={`conversion-format-${item.id}`}>
                      <span>Output format</span>
                      <select
                        id={`conversion-format-${item.id}`}
                        defaultValue="pdf"
                        aria-describedby={`conversion-help-${item.id}`}
                      >
                        <option value="pdf">PDF</option>
                      </select>
                    </label>
                    <div className="conversion-actions">
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={actionsPending}
                        onClick={() => onSetConversionDraft(null)}
                      >
                        Cancel
                      </button>
                      <button className="primary-button" disabled={actionsPending} type="submit">
                        {pendingAction === `job-enqueue:${item.id}`
                          ? "Queueing…"
                          : "Choose output…"}
                      </button>
                    </div>
                  </form>
                )}

                {editing && draft && (
                  <form
                    className="edit-panel"
                    id={`edit-${item.id}`}
                    aria-label={`Edit ${item.title}`}
                    onSubmit={(event) => void onSaveMetadata(event, item)}
                  >
                    <label>
                      <span>Title</span>
                      <input
                        required
                        value={draft.title}
                        onChange={(event) =>
                          onSetDraft({ ...draft, title: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Author</span>
                      <input
                        value={draft.author}
                        onChange={(event) =>
                          onSetDraft({ ...draft, author: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="full-field">
                      <span>Description</span>
                      <textarea
                        rows={3}
                        value={draft.description}
                        onChange={(event) =>
                          onSetDraft({ ...draft, description: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="full-field">
                      <span>Tags</span>
                      <input
                        value={draft.tags}
                        aria-describedby={`tag-help-${item.id}`}
                        onChange={(event) =>
                          onSetDraft({ ...draft, tags: event.currentTarget.value })
                        }
                      />
                      <small id={`tag-help-${item.id}`}>Separate tags with commas.</small>
                    </label>
                    <div className="cover-actions full-field">
                      <span>Cover</span>
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={actionsPending}
                        onClick={() => void onChooseCover(item)}
                      >
                        {pendingAction === `cover:${item.id}` ? "Updating…" : "Choose image"}
                      </button>
                      {item.coverPath && (
                        <button
                          type="button"
                          className="quiet-button"
                          disabled={actionsPending}
                          onClick={() => void onClearCover(item)}
                        >
                          Remove cover
                        </button>
                      )}
                    </div>
                    <div className="edit-actions full-field">
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={actionsPending}
                        onClick={() => onSetDraft(null)}
                      >
                        Cancel
                      </button>
                      <button className="primary-button" disabled={actionsPending} type="submit">
                        {pendingAction === `edit:${item.id}` ? "Saving…" : "Save changes"}
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
