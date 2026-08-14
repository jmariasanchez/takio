import type {
  AttachLibraryFormatRequest,
  LibraryBatchImportStore,
  LibraryImportEntryOutcome,
  LibraryImportReport,
  LibraryMetadataPatch,
  LibraryStore,
} from "@takio/library-contract";
import { detectFormat, type FormatId, type LibraryItem } from "@takio/core";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverEbookMeta,
  extractEbookMetadata,
  type ExtractedCover,
} from "./metadata.js";

const DEFAULT_METADATA_TIMEOUT_MS = 15_000;

export type MetadataImportStore = Pick<LibraryStore, "update" | "setCover">;
export type CalibreImportStore = LibraryBatchImportStore &
  Pick<LibraryStore, "attachFormat" | "update" | "setCover">;

export class CalibreImportError extends Error {
  constructor(readonly code: "invalid-arguments" | "not-found" | "unreadable" | "storage-unavailable") {
    super(code);
  }
}

type CalibreBook = {
  id: number;
  title: string;
  path: string;
  authors: { name: string; sortName?: string }[];
  series?: string;
  seriesIndex?: number;
  publisher?: string;
  publishedDate?: string;
  rating?: number;
  identifiers: Record<string, string>;
  languages: string[];
  tags: string[];
  description?: string;
  customMetadata: Record<string, string>;
  formats: { format: FormatId; path: string }[];
  coverPath?: string;
};

export type EnrichImportedLibraryOutcomesOptions = Readonly<{
  /** Use only for the explicit title supplied to a single-item import. */
  titleOverride?: string;
  timeoutMs?: number;
}>;

function isManagedImport(outcome: LibraryImportEntryOutcome): boolean {
  if (outcome.status !== "imported") {
    return false;
  }
  const primaryFormat = outcome.item.formats[0];
  return (
    primaryFormat?.sourcePath === outcome.item.sourcePath &&
    primaryFormat.provenance === "managed"
  );
}

async function installCover(
  store: MetadataImportStore,
  itemId: string,
  cover: ExtractedCover,
) {
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-import-cover-"));
    await chmod(workspace, 0o700);
    const sourcePath = join(workspace, `cover${cover.extension}`);
    await writeFile(sourcePath, cover.bytes, { flag: "wx", mode: 0o600 });
    return await store.setCover({ id: itemId, sourcePath });
  } catch {
    return null;
  } finally {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function enrichImportedLibraryOutcomes(
  store: MetadataImportStore,
  outcomes: readonly LibraryImportEntryOutcome[],
  options: EnrichImportedLibraryOutcomesOptions = {},
): Promise<readonly LibraryImportEntryOutcome[]> {
  if (!outcomes.some(isManagedImport)) {
    return outcomes;
  }

  let backendPath: string;
  try {
    const discovery = await discoverEbookMeta();
    if (!discovery.ok) {
      return outcomes;
    }
    backendPath = discovery.path;
  } catch {
    return outcomes;
  }

  const enriched = [...outcomes];
  for (const [index, outcome] of outcomes.entries()) {
    if (!isManagedImport(outcome) || outcome.status !== "imported") {
      continue;
    }

    try {
      const extracted = await extractEbookMetadata({
        backendPath,
        sourcePath: outcome.item.sourcePath,
        timeoutMs: options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      });
      const patch =
        options.titleOverride === undefined
          ? extracted.metadata
          : { ...extracted.metadata, title: options.titleOverride };
      const updated = await store.update({ id: outcome.item.id, patch });
      if (!updated.ok || !updated.value) {
        continue;
      }

      let item = updated.value;
      if (extracted.cover) {
        const covered = await installCover(store, item.id, extracted.cover);
        if (covered?.ok && covered.value) {
          item = covered.value;
        }
      }
      enriched[index] = { ...outcome, item };
    } catch {
      // Metadata enrichment is best effort; the managed import remains authoritative.
    }
  }

  return enriched;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : undefined;
}

function publishedDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value);
  if (!match) return undefined;
  return [match[1], match[2], match[3]].filter(Boolean).join("-");
}

function language(value: unknown): string | undefined {
  const normalized = text(value)?.replace(/_/g, "-");
  return normalized && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized) ? normalized : undefined;
}

function maybeJson(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function rowsByBook<T extends { book: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) grouped.set(row.book, [...(grouped.get(row.book) ?? []), row]);
  return grouped;
}

function calibreBooks(database: Database, root: string): CalibreBook[] {
  type BookRow = { id: number; title: string; path: string; seriesIndex: number | null; pubdate: string | null };
  const books = database.query<BookRow, []>(`
    SELECT books.id, books.title, books.path, books.series_index AS seriesIndex, books.pubdate
    FROM books ORDER BY books.id
  `).all();
  const authors = rowsByBook(database.query<{ book: number; name: string; sort: string | null }, []>(`
    SELECT books_authors_link.book, authors.name, authors.sort
    FROM books_authors_link JOIN authors ON authors.id = books_authors_link.author
    ORDER BY books_authors_link.book, books_authors_link.id
  `).all());
  const simple = (table: string, link: string, column: string, key: string) => rowsByBook(
    database.query<{ book: number; value: string }, []>(`
      SELECT ${link}.book, ${table}.${key} AS value FROM ${link}
      JOIN ${table} ON ${table}.id = ${link}.${column}
      ORDER BY ${link}.book, ${link}.id
    `).all(),
  );
  const series = simple("series", "books_series_link", "series", "name");
  const publishers = simple("publishers", "books_publishers_link", "publisher", "name");
  const tags = simple("tags", "books_tags_link", "tag", "name");
  const ratings = rowsByBook(database.query<{ book: number; value: number }, []>(`
    SELECT books_ratings_link.book, ratings.rating AS value FROM books_ratings_link
    JOIN ratings ON ratings.id = books_ratings_link.rating ORDER BY books_ratings_link.book, books_ratings_link.id
  `).all());
  const languages = rowsByBook(database.query<{ book: number; value: string }, []>(`
    SELECT books_languages_link.book, languages.lang_code AS value FROM books_languages_link
    JOIN languages ON languages.id = books_languages_link.lang_code ORDER BY books_languages_link.book, books_languages_link.item_order
  `).all());
  const identifiers = rowsByBook(database.query<{ book: number; type: string; val: string }, []>(`
    SELECT book, type, val FROM identifiers ORDER BY book, type, val
  `).all());
  const comments = rowsByBook(database.query<{ book: number; text: string }, []>(`
    SELECT book, text FROM comments ORDER BY book
  `).all());
  const formats = rowsByBook(database.query<{ book: number; format: string; name: string }, []>(`
    SELECT book, format, name FROM data ORDER BY book, format, id
  `).all());
  const custom: Record<number, Record<string, string>> = {};
  for (const table of database.query<{ name: string; label: string }, []>(`
    SELECT name, label FROM custom_columns ORDER BY label
  `).all()) {
    if (!/^custom_column_\d+$/.test(table.name)) continue;
    try {
      for (const row of database.query<{ book: number; value: unknown }, []>(`
        SELECT book, value FROM ${table.name} ORDER BY book
      `).all()) {
        const key = table.label.replace(/^#/, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().slice(0, 64);
        if (/^[a-z][a-z0-9_]{0,63}$/.test(key)) (custom[row.book] ??= {})[key] = maybeJson(row.value);
      }
    } catch {}
  }
  return books.map((book) => {
    const bookDir = join(root, book.path);
    return {
      id: book.id,
      title: book.title,
      path: book.path,
      authors: (authors.get(book.id) ?? []).map((a) => ({ name: a.name, ...(text(a.sort) ? { sortName: text(a.sort) } : {}) })),
      series: text(series.get(book.id)?.[0]?.value),
      seriesIndex: typeof book.seriesIndex === "number" ? book.seriesIndex : undefined,
      publisher: text(publishers.get(book.id)?.[0]?.value),
      publishedDate: publishedDate(book.pubdate),
      identifiers: Object.fromEntries((identifiers.get(book.id) ?? []).map((i) => [i.type, i.val]).filter(([k, v]) => text(k) && text(v))),
      languages: [...new Set((languages.get(book.id) ?? []).map((l) => language(l.value)).filter((v): v is string => !!v))],
      tags: [...new Set((tags.get(book.id) ?? []).map((t) => text(t.value)).filter((v): v is string => !!v))],
      description: text(comments.get(book.id)?.[0]?.text),
      customMetadata: custom[book.id] ?? {},
      formats: (formats.get(book.id) ?? []).map((f) => {
        const path = join(bookDir, `${f.name}.${f.format.toLowerCase()}`);
        return { path, format: detectFormat(path) };
      }).filter((f): f is { format: FormatId; path: string } => !!f.format),
      coverPath: join(bookDir, "cover.jpg"),
      rating: typeof ratings.get(book.id)?.[0]?.value === "number" ? ratings.get(book.id)![0]!.value * 2 : undefined,
    };
  }).filter((book) => book.formats.length > 0);
}

function patchFor(book: CalibreBook): LibraryMetadataPatch {
  return {
    title: book.title,
    ...(book.authors.length ? { authors: book.authors, author: book.authors[0]?.name } : {}),
    ...(book.series ? { series: book.series } : {}),
    ...(book.seriesIndex !== undefined ? { seriesIndex: book.seriesIndex } : {}),
    ...(book.publisher ? { publisher: book.publisher } : {}),
    ...(book.publishedDate ? { publishedDate: book.publishedDate } : {}),
    ...(book.rating !== undefined ? { rating: book.rating } : {}),
    ...(Object.keys(book.identifiers).length ? { identifiers: book.identifiers } : {}),
    ...(book.languages.length ? { languages: book.languages } : {}),
    ...(book.description ? { description: book.description } : {}),
    ...(Object.keys(book.customMetadata).length ? { customMetadata: book.customMetadata } : {}),
    tags: book.tags,
  };
}

export async function importCalibreLibrary(
  store: CalibreImportStore,
  libraryRoot: string,
): Promise<LibraryImportReport> {
  let root: string;
  try {
    root = await realpath(libraryRoot);
    if (!(await stat(join(root, "metadata.db"))).isFile()) throw new Error("metadata.db missing");
  } catch { throw new CalibreImportError("not-found"); }

  let database: Database;
  try {
    database = new Database(`file:${join(root, "metadata.db")}?mode=ro&immutable=1`, { readonly: true, strict: true });
    database.run("PRAGMA query_only = ON");
    database.run("PRAGMA busy_timeout = 250");
  } catch { throw new CalibreImportError("unreadable"); }

  const outcomes: LibraryImportEntryOutcome[] = [];
  try {
    const books = calibreBooks(database, root);
    const importedPrimaries = await store.importMany({ roots: books.map((book) => book.formats[0]!.path) });
    if (!importedPrimaries.ok) throw new CalibreImportError("storage-unavailable");
    for (const [index, book] of books.entries()) {
      const primary = book.formats[0]!;
      const primaryOutcome = importedPrimaries.value.outcomes[index];
      if (!primaryOutcome || primaryOutcome.status !== "imported") {
        if (primaryOutcome) outcomes.push(primaryOutcome);
        else outcomes.push({ status: "failed", sourcePath: primary.path, code: "storage-unavailable" });
        continue;
      }
      let item: LibraryItem = primaryOutcome.item;
      for (const extra of book.formats.slice(1)) {
        const attached = await store.attachFormat({ id: item.id, source: { kind: "copy", path: extra.path } } satisfies AttachLibraryFormatRequest);
        if (attached.ok && attached.value) item = attached.value;
      }
      const updated = await store.update({ id: item.id, patch: patchFor(book) });
      if (updated.ok && updated.value) item = updated.value;
      try {
        if (book.coverPath && (await stat(book.coverPath)).isFile()) {
          const covered = await store.setCover({ id: item.id, sourcePath: book.coverPath });
          if (covered.ok && covered.value) item = covered.value;
        }
      } catch {}
      outcomes.push({ status: "imported", sourcePath: primary.path, item });
    }
  } catch { throw new CalibreImportError("storage-unavailable"); }
  finally { database.close(); }
  return {
    outcomes,
    counts: {
      total: outcomes.length,
      imported: outcomes.filter((o) => o.status === "imported").length,
      skipped: outcomes.filter((o) => o.status === "skipped").length,
      duplicates: outcomes.filter((o) => o.status === "duplicate").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
    },
  };
}
