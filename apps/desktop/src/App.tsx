import { useCallback, useEffect, useState } from "react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { FORMAT_CATALOG, type LibraryItem } from "@takio/core";

import {
  describeLibraryError,
  importLibraryItem,
  listLibraryItems,
  removeLibraryItem,
} from "./lib/library";
import "./styles.css";

const supportedExtensions = FORMAT_CATALOG.flatMap((format) =>
  format.extensions.map((extension) => extension.slice(1)),
);

type LibraryState = "loading" | "ready" | "error";
type Notice = { readonly kind: "status" | "error"; readonly text: string } | null;

function addedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function caughtMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The local library is unavailable.";
}

export default function App() {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [libraryState, setLibraryState] = useState<LibraryState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const loadLibrary = useCallback(async (showLoading = true): Promise<boolean> => {
    if (showLoading) {
      setLibraryState("loading");
    }

    try {
      const result = await listLibraryItems();
      if (!result.ok) {
        setLibraryState("error");
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return false;
      }

      setItems(result.value.items);
      setLibraryState("ready");
      return true;
    } catch (error) {
      setLibraryState("error");
      setNotice({ kind: "error", text: caughtMessage(error) });
      return false;
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  async function importFile() {
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: false,
        filters: [{ name: "Supported books and documents", extensions: supportedExtensions }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: caughtMessage(error) });
      return;
    }

    if (typeof selection !== "string") {
      return;
    }

    setPendingAction("import");
    setNotice(null);
    try {
      const result = await importLibraryItem(selection);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      setNotice({ kind: "status", text: `Imported “${result.value.item.title}”.` });
      await loadLibrary(false);
    } catch (error) {
      setNotice({ kind: "error", text: caughtMessage(error) });
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
      setNotice({ kind: "error", text: caughtMessage(error) });
      return;
    }

    if (!approved) {
      return;
    }

    setPendingAction(item.id);
    setNotice(null);
    try {
      const result = await removeLibraryItem(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      setItems((currentItems) => currentItems.filter((candidate) => candidate.id !== item.id));
      setLibraryState("ready");
      setNotice({ kind: "status", text: `Removed “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: caughtMessage(error) });
    } finally {
      setPendingAction(null);
    }
  }

  const actionsPending = pendingAction !== null;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><span>takio</span></div>
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

        {notice ? (
          <p className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        ) : <div className="notice" aria-hidden="true" />}

        <section className="library-section" aria-busy={libraryState === "loading"}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">FILES</p>
              <h2>Your library</h2>
            </div>
            {libraryState === "ready" && <span className="item-count">{items.length} {items.length === 1 ? "item" : "items"}</span>}
          </div>

          {libraryState === "loading" && <div className="state-panel">Loading your library…</div>}

          {libraryState === "error" && items.length === 0 && (
            <div className="state-panel error-panel">
              <strong>Library unavailable</strong>
              <span>Takio could not load the files stored on this device.</span>
              <button className="quiet-button" disabled={actionsPending} onClick={() => void loadLibrary()}>
                Try again
              </button>
            </div>
          )}

          {libraryState === "ready" && items.length === 0 && (
            <div className="state-panel">
              <strong>No files yet</strong>
              <span>Choose a supported book or document to start your local library.</span>
            </div>
          )}

          {items.length > 0 && (
            <div className="book-list">
              {items.map((item) => (
                <article className="book-row" key={item.id}>
                  <div className="cover" aria-hidden="true">{item.title.slice(0, 1).toUpperCase()}</div>
                  <div className="book-title">
                    <strong>{item.title}</strong>
                    <span>{item.format.toUpperCase()} · Added {addedDate(item.addedAt)}</span>
                  </div>
                  <button
                    className="row-button"
                    aria-label={`Remove ${item.title}`}
                    disabled={actionsPending}
                    onClick={() => void removeItem(item)}
                  >
                    {pendingAction === item.id ? "Removing…" : "Remove"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
