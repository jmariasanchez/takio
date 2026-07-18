import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import "./styles.css";

const formats = ["EPUB", "PDF", "MOBI", "AZW3", "DOCX", "HTML", "TXT", "CBZ"];
const recentBooks = [
  { title: "The Long Way to a Small, Angry Planet", source: "EPUB", size: "1.8 MB", status: "Ready" },
  { title: "Designing Data-Intensive Applications", source: "PDF", size: "5.4 MB", status: "Ready" },
  { title: "Collected Essays", source: "DOCX", size: "328 KB", status: "Ready" },
];

export default function App() {
  const [outputFormat, setOutputFormat] = useState("PDF");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [notice, setNotice] = useState("Your library stays on this device.");

  async function chooseFile() {
    const selection = await open({
      multiple: false,
      filters: [{ name: "Supported books and documents", extensions: ["epub", "pdf", "mobi", "azw3", "docx", "html", "htm", "txt", "cbz"] }],
    });
    if (typeof selection === "string") {
      setSelectedFile(selection);
      setNotice("Ready to create a conversion job.");
    }
  }

  function planConversion() {
    if (!selectedFile) {
      setNotice("Choose a file before creating a conversion.");
      return;
    }
    setNotice(`Planned ${selectedFile.split("/").at(-1)} → ${outputFormat}. Converter adapters come next.`);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><span>takio</span></div>
        <nav aria-label="Main navigation">
          <button className="nav-item active"><span>⌘</span>Library</button>
          <button className="nav-item"><span>↻</span>Queue <em>0</em></button>
          <button className="nav-item"><span>◌</span>Devices</button>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> Local controller online
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div><p className="eyebrow">LIBRARY</p><h1>Convert without the clutter.</h1></div>
          <button className="quiet-button" onClick={() => setNotice("Settings will manage agents, adapters, and storage.")}>Settings</button>
        </header>

        <section className="hero-card" aria-label="Create conversion">
          <div>
            <p className="eyebrow">NEW CONVERSION</p>
            <h2>{selectedFile ? selectedFile.split("/").at(-1) : "Drop in a book or document"}</h2>
            <p>{selectedFile ? "Select an output and send this job to a capable device." : "Takio will pick the best available device for the job."}</p>
          </div>
          <div className="conversion-controls">
            <button className="file-button" onClick={chooseFile}>Choose file</button>
            <label>Convert to
              <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)}>
                {formats.map((format) => <option key={format}>{format}</option>)}
              </select>
            </label>
            <button className="primary-button" onClick={planConversion}>Create plan <span>→</span></button>
          </div>
        </section>

        <p className="notice" role="status">{notice}</p>

        <section className="library-section">
          <div className="section-heading"><div><p className="eyebrow">RECENT</p><h2>Your library</h2></div><button className="text-button">View all</button></div>
          <div className="book-list">
            {recentBooks.map((book) => (
              <article className="book-row" key={book.title}>
                <div className="cover" aria-hidden="true">{book.title.slice(0, 1)}</div>
                <div className="book-title"><strong>{book.title}</strong><span>{book.source} · {book.size}</span></div>
                <span className="ready"><i />{book.status}</span>
                <button className="row-button" aria-label={`Plan conversion for ${book.title}`}>···</button>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
