import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { FORMAT_CATALOG, type Destination, type LibraryItem } from "@takio/core";

import {
  describeDestinationError,
  describeUnexpectedDestinationError,
  ejectDestination,
  listDestinations,
  sendLibraryItem,
} from "./lib/destinations";
import { formatFileSize } from "./lib/format";
import {
  describeLibraryError,
  describeUnexpectedLibraryError,
  importLibraryItem,
  listLibraryItems,
  openLibraryItem,
  parseLibraryTags,
  removeLibraryCover,
  removeLibraryItem,
  searchLibraryItems,
  setLibraryCover,
  updateLibraryItem,
} from "./lib/library";
import "./styles.css";

const supportedExtensions = FORMAT_CATALOG.flatMap((format) =>
  format.extensions.map((extension) => extension.slice(1)),
);
const coverExtensions = ["png", "jpg", "jpeg", "webp", "gif"];

type LibraryState = "loading" | "ready" | "error";
type Notice = { readonly kind: "status" | "error"; readonly text: string } | null;
type MetadataDraft = {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly description: string;
  readonly tags: string;
};
type MenuActionHandlers = {
  readonly importFiles: () => Promise<void>;
  readonly importPaths: (paths: readonly string[]) => Promise<void>;
  readonly openSelected: () => Promise<void>;
  readonly sendSelected: () => Promise<void>;
  readonly ejectSelected: () => Promise<void>;
  readonly find: () => void;
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

export default function App() {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [libraryState, setLibraryState] = useState<LibraryState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<readonly Destination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [selectedDestinationId, setSelectedDestinationId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const requestSequence = useRef(0);
  const destinationRequestSequence = useRef(0);
  const deviceMutationPending = useRef(false);
  const importPending = useRef(false);
  const queryRef = useRef(query);
  const searchInput = useRef<HTMLInputElement>(null);
  const menuActionHandlers = useRef<MenuActionHandlers | null>(null);
  queryRef.current = query;

  const loadLibrary = useCallback(
    async (showLoading = true, searchQuery = ""): Promise<boolean> => {
      const request = ++requestSequence.current;
      if (showLoading) {
        setLibraryState("loading");
      } else {
        setSearchPending(true);
      }

      try {
        const result =
          searchQuery === "" ? await listLibraryItems() : await searchLibraryItems(searchQuery);
        if (request !== requestSequence.current) {
          return false;
        }
        if (!result.ok) {
          setLibraryState("error");
          setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
          return false;
        }

        setItems(result.value.items);
        setSelectedItemId((currentId) =>
          currentId && result.value.items.some((item) => item.id === currentId)
            ? currentId
            : null,
        );
        setLibraryState("ready");
        return true;
      } catch (error) {
        if (request !== requestSequence.current) {
          return false;
        }
        setLibraryState("error");
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        return false;
      } finally {
        if (request === requestSequence.current) {
          setSearchPending(false);
        }
      }
    },
    [],
  );

  const loadDestinations = useCallback(async (showLoading = true): Promise<boolean> => {
    const request = ++destinationRequestSequence.current;
    if (showLoading) {
      setDestinationsLoading(true);
    }
    try {
      const result = await listDestinations();
      if (request !== destinationRequestSequence.current) {
        return false;
      }
      if (!result.ok) {
        setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
        return false;
      }

      setDestinations(result.value.destinations);
      setSelectedDestinationId((currentId) =>
        currentId &&
        result.value.destinations.some((destination) => destination.id === currentId)
          ? currentId
          : null,
      );
      return true;
    } catch (error) {
      if (request !== destinationRequestSequence.current) {
        return false;
      }
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
      return false;
    } finally {
      if (request === destinationRequestSequence.current) {
        setDestinationsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
    void loadDestinations();

    // ponytail: passive polling is enough for Calibre-style reader discovery;
    // replace it with mount events only if polling becomes measurably expensive.
    const destinationRefresh = window.setInterval(() => {
      if (!deviceMutationPending.current) {
        void loadDestinations(false);
      }
    }, 10_000);

    return () => window.clearInterval(destinationRefresh);
  }, [loadDestinations, loadLibrary]);

  function replaceItem(updated: LibraryItem): void {
    setItems((currentItems) =>
      currentItems.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  function changeSearch(searchQuery: string): void {
    setQuery(searchQuery);
    void loadLibrary(false, searchQuery);
  }

  const importPaths = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0 || importPending.current) {
        return;
      }

      importPending.current = true;
      setPendingAction("import");
      setNotice(null);

      let imported = 0;
      const rejected: string[] = [];
      for (const path of paths) {
        try {
          const result = await importLibraryItem(path);
          if (result.ok) {
            imported += 1;
          } else {
            rejected.push(`${path}: ${describeLibraryError(result.error.code)}`);
          }
        } catch (error) {
          rejected.push(`${path}: ${describeUnexpectedLibraryError(error)}`);
        }
      }

      const refreshed = await loadLibrary(false, queryRef.current);
      const summary = `${imported} ${imported === 1 ? "item" : "items"} imported; ${rejected.length} rejected.`;
      const details = rejected.map((error) => `• ${error}`);
      if (!refreshed) {
        details.push("• The library could not be refreshed.");
      }
      setNotice({
        kind: rejected.length > 0 || !refreshed ? "error" : "status",
        text: [summary, ...details].join("\n"),
      });
      importPending.current = false;
      setPendingAction(null);
    },
    [loadLibrary],
  );

  async function importFile(): Promise<void> {
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: true,
        filters: [{ name: "Supported books and documents", extensions: supportedExtensions }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }

    if (selection === null) {
      return;
    }

    await importPaths(typeof selection === "string" ? [selection] : selection);
  }

  async function saveMetadata(event: FormEvent, item: LibraryItem) {
    event.preventDefault();
    if (!draft || draft.id !== item.id) {
      return;
    }

    const title = draft.title.trim();
    if (title === "") {
      setNotice({ kind: "error", text: "Title is required." });
      return;
    }

    let tags: readonly string[];
    try {
      tags = parseLibraryTags(draft.tags);
    } catch {
      setNotice({
        kind: "error",
        text: "Use unique, nonempty tags separated by commas.",
      });
      return;
    }

    setPendingAction(`edit:${item.id}`);
    setNotice(null);
    try {
      const result = await updateLibraryItem(item.id, {
        title,
        author: draft.author.trim() || null,
        description: draft.description.trim() || null,
        tags,
      });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setDraft(null);
      setNotice({ kind: "status", text: `Saved “${result.value.item.title}”.` });
      if (query !== "") {
        await loadLibrary(false, query);
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function chooseCover(item: LibraryItem) {
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: false,
        filters: [{ name: "Cover images", extensions: coverExtensions }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }
    if (typeof selection !== "string") {
      return;
    }

    setPendingAction(`cover:${item.id}`);
    setNotice(null);
    try {
      const result = await setLibraryCover(item.id, selection);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setNotice({ kind: "status", text: `Updated the cover for “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function clearCover(item: LibraryItem) {
    setPendingAction(`cover:${item.id}`);
    setNotice(null);
    try {
      const result = await removeLibraryCover(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setNotice({ kind: "status", text: `Removed the cover for “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function removeItem(item: LibraryItem) {
    let approved: boolean;
    try {
      approved = await confirm(
        `Remove “${item.title}” from your Takio library? Takio will also delete its owned imported copy, if present.`,
        { title: "Remove from library", kind: "warning" },
      );
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }

    if (!approved) {
      return;
    }

    setPendingAction(`remove:${item.id}`);
    setNotice(null);
    try {
      const result = await removeLibraryItem(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      setItems((currentItems) => currentItems.filter((candidate) => candidate.id !== item.id));
      setDraft((currentDraft) => (currentDraft?.id === item.id ? null : currentDraft));
      setSelectedItemId((currentId) => (currentId === item.id ? null : currentId));
      setLibraryState("ready");
      setNotice({ kind: "status", text: `Removed “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function openItem(item: LibraryItem) {
    setSelectedItemId(item.id);
    setPendingAction(`open:${item.id}`);
    setNotice(null);
    try {
      const result = await openLibraryItem(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      setNotice({ kind: "status", text: `Opened “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function refreshDestinations() {
    setNotice(null);
    if (await loadDestinations()) {
      setNotice({ kind: "status", text: "Reader list refreshed." });
    }
  }

  async function sendItem(item: LibraryItem) {
    if (deviceMutationPending.current) {
      return;
    }
    setSelectedItemId(item.id);
    if (!selectedDestination) {
      setNotice({ kind: "error", text: "Choose a reader before sending." });
      return;
    }

    deviceMutationPending.current = true;
    setPendingAction(`send:${item.id}`);
    setNotice(null);
    try {
      const result = await sendLibraryItem(item.id, selectedDestination.path);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
        return;
      }

      setNotice({
        kind: "status",
        text: `Sent to ${result.value.path} · ${result.value.bytes.toLocaleString()} bytes · SHA-256 ${result.value.sha256}`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
    } finally {
      deviceMutationPending.current = false;
      setPendingAction(null);
    }
  }

  async function ejectSelectedDestination() {
    if (deviceMutationPending.current) {
      return;
    }
    if (!selectedDestination) {
      setNotice({ kind: "error", text: "Choose a reader before ejecting." });
      return;
    }

    const destination = selectedDestination;
    deviceMutationPending.current = true;
    setPendingAction("eject");
    setNotice(null);
    try {
      const result = await ejectDestination(destination.path);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
        return;
      }

      setSelectedDestinationId(null);
      if (await loadDestinations()) {
        setNotice({ kind: "status", text: `Ejected ${destination.name}.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
    } finally {
      deviceMutationPending.current = false;
      setPendingAction(null);
    }
  }

  const actionsPending = pendingAction !== null;
  const selectedDestination =
    destinations.find((destination) => destination.id === selectedDestinationId) ?? null;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

  async function openSelectedItem(): Promise<void> {
    if (!selectedItem) {
      setNotice({ kind: "error", text: "Choose a library item before opening." });
      return;
    }
    await openItem(selectedItem);
  }

  async function sendSelectedItem(): Promise<void> {
    if (!selectedItem) {
      setNotice({ kind: "error", text: "Choose a library item before sending." });
      return;
    }
    await sendItem(selectedItem);
  }

  menuActionHandlers.current = {
    importFiles: importFile,
    importPaths,
    openSelected: openSelectedItem,
    sendSelected: sendSelectedItem,
    ejectSelected: ejectSelectedDestination,
    find: () => searchInput.current?.focus(),
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>(
      "takio://menu-action",
      ({ payload }) => {
        const handlers = menuActionHandlers.current;
        if (!handlers) {
          return;
        }

        switch (payload) {
          case "import":
            void handlers.importFiles();
            break;
          case "open-selected":
            void handlers.openSelected();
            break;
          case "send-selected":
            void handlers.sendSelected();
            break;
          case "eject-selected":
            void handlers.ejectSelected();
            break;
          case "find":
            handlers.find();
            break;
        }
      },
      { target: { kind: "WebviewWindow", label: "main" } },
    )
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") {
          setDropActive(true);
          return;
        }

        setDropActive(false);
        if (payload.type === "drop") {
          void menuActionHandlers.current?.importPaths(payload.paths);
        }
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <main className={`app-shell${dropActive ? " drop-active" : ""}`}>
      {dropActive && (
        <div className="drop-affordance" role="status">
          Drop files to import
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <span>takio</span>
        </div>
        <nav aria-label="Main navigation">
          <span className="nav-item active"><span aria-hidden="true">⌘</span>Library</span>
        </nav>
        <div className="sidebar-footer">Stored locally on this device</div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">LIBRARY</p>
            <h1>Your local library.</h1>
          </div>
        </header>

        <section className="hero-card" aria-labelledby="import-heading">
          <div>
            <p className="eyebrow">IMPORT</p>
            <h2 id="import-heading">Add a book or document</h2>
            <p>Takio keeps an owned copy here so it is available after you relaunch.</p>
          </div>
          <button className="primary-button" disabled={actionsPending} onClick={importFile}>
            {pendingAction === "import" ? "Importing…" : "Choose file"}
          </button>
        </section>

        <section className="reader-bar" aria-label="Connected readers">
          <div className="reader-heading">
            <p className="eyebrow">READER</p>
            <strong>Send to a mounted device</strong>
          </div>
          <div className="reader-controls">
            <select
              aria-label="Selected reader"
              value={selectedDestinationId ?? ""}
              disabled={actionsPending || destinationsLoading}
              onChange={(event) =>
                setSelectedDestinationId(event.currentTarget.value || null)
              }
            >
              <option value="">Choose a reader…</option>
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                </option>
              ))}
            </select>
            <span className="reader-detail" aria-live="polite">
              {destinationsLoading
                ? "Scanning…"
                : selectedDestination
                  ? `${selectedDestination.kind[0]?.toUpperCase()}${selectedDestination.kind.slice(1)} · ${
                      selectedDestination.freeBytes === undefined
                        ? "Free space unavailable"
                        : `${formatFileSize(selectedDestination.freeBytes)} free`
                    }`
                  : `${destinations.length} ${destinations.length === 1 ? "reader" : "readers"} found`}
            </span>
            <button
              className="quiet-button"
              disabled={actionsPending || destinationsLoading}
              onClick={() => void refreshDestinations()}
            >
              {destinationsLoading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              className="quiet-button"
              disabled={!selectedDestination || actionsPending || destinationsLoading}
              onClick={() => void ejectSelectedDestination()}
            >
              {pendingAction === "eject" ? "Ejecting…" : "Eject"}
            </button>
          </div>
        </section>

        {notice ? (
          <p className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        ) : <div className="notice" aria-hidden="true" />}

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
              onChange={(event) => changeSearch(event.currentTarget.value)}
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
                onClick={() => void loadLibrary(true, query)}
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
                const selected = selectedItemId === item.id;
                return (
                  <article
                    className={`book-card${selected ? " selected" : ""}`}
                    key={item.id}
                    tabIndex={0}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => setSelectedItemId(item.id)}
                    onFocus={() => setSelectedItemId(item.id)}
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
                          {item.format.toUpperCase()} · Added {addedDate(item.addedAt)}
                        </span>
                        {item.tags.length > 0 && (
                          <span className="tag-summary">{item.tags.join(" · ")}</span>
                        )}
                        {selected && <span className="selection-label">Selected</span>}
                      </div>
                      <div className="row-actions">
                        <button
                          className="row-button"
                          aria-label={`Open ${item.title}`}
                          disabled={actionsPending}
                          onClick={() => void openItem(item)}
                        >
                          {pendingAction === `open:${item.id}` ? "Opening…" : "Open"}
                        </button>
                        <button
                          className="row-button send-button"
                          aria-label={`Send ${item.title} to the selected reader`}
                          disabled={actionsPending || !selectedDestination}
                          onClick={() => void sendItem(item)}
                        >
                          {pendingAction === `send:${item.id}` ? "Sending…" : "Send"}
                        </button>
                        <button
                          className="row-button"
                          aria-expanded={editing}
                          disabled={actionsPending}
                          onClick={() => setDraft(editing ? null : draftFor(item))}
                        >
                          {editing ? "Cancel edit" : "Edit"}
                        </button>
                        <button
                          className="row-button danger-button"
                          aria-label={`Remove ${item.title}`}
                          disabled={actionsPending}
                          onClick={() => void removeItem(item)}
                        >
                          {pendingAction === `remove:${item.id}` ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    </div>

                    {editing && draft && (
                      <form
                        className="edit-panel"
                        aria-label={`Edit ${item.title}`}
                        onSubmit={(event) => void saveMetadata(event, item)}
                      >
                        <label>
                          <span>Title</span>
                          <input
                            required
                            value={draft.title}
                            onChange={(event) =>
                              setDraft({ ...draft, title: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label>
                          <span>Author</span>
                          <input
                            value={draft.author}
                            onChange={(event) =>
                              setDraft({ ...draft, author: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label className="full-field">
                          <span>Description</span>
                          <textarea
                            rows={3}
                            value={draft.description}
                            onChange={(event) =>
                              setDraft({ ...draft, description: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label className="full-field">
                          <span>Tags</span>
                          <input
                            value={draft.tags}
                            aria-describedby={`tag-help-${item.id}`}
                            onChange={(event) =>
                              setDraft({ ...draft, tags: event.currentTarget.value })
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
                            onClick={() => void chooseCover(item)}
                          >
                            {pendingAction === `cover:${item.id}` ? "Updating…" : "Choose image"}
                          </button>
                          {item.coverPath && (
                            <button
                              type="button"
                              className="quiet-button"
                              disabled={actionsPending}
                              onClick={() => void clearCover(item)}
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
                            onClick={() => setDraft(null)}
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
      </section>
    </main>
  );
}
