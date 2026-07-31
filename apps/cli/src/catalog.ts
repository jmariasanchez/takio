import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { FormatId, LibraryItem } from "@takio/core";

export const CATALOG_FORMATS = ["json", "csv", "html"] as const;
export type CatalogFormat = (typeof CATALOG_FORMATS)[number];

export type CatalogRecord = {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly tags: readonly string[];
  readonly formats: readonly FormatId[];
  readonly hasCover: boolean;
  readonly series?: string;
  readonly seriesIndex?: number;
  readonly publisher?: string;
  readonly publishedDate?: string;
  readonly languages?: readonly string[];
  readonly identifiers?: Readonly<Record<string, string>>;
  readonly customMetadata?: Readonly<Record<string, string>>;
  readonly rating?: number;
  readonly description?: string;
};

export class CatalogError extends Error {
  constructor(readonly code: "invalid-arguments" | "output-file-exists" | "write-failed") {
    super(code);
  }
}

export function catalogRecord(item: LibraryItem): CatalogRecord {
  return {
    id: item.id,
    title: item.title,
    authors: item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []),
    tags: item.tags,
    formats: item.formats.map(({ format }) => format),
    hasCover: item.coverPath !== undefined,
    ...(item.series ? { series: item.series } : {}),
    ...(item.seriesIndex !== undefined ? { seriesIndex: item.seriesIndex } : {}),
    ...(item.publisher ? { publisher: item.publisher } : {}),
    ...(item.publishedDate ? { publishedDate: item.publishedDate } : {}),
    ...(item.languages ? { languages: item.languages } : {}),
    ...(item.identifiers ? { identifiers: item.identifiers } : {}),
    ...(item.customMetadata ? { customMetadata: item.customMetadata } : {}),
    ...(item.rating !== undefined ? { rating: item.rating } : {}),
    ...(item.description ? { description: item.description } : {}),
  };
}

function escapeCsv(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderCatalog(items: readonly LibraryItem[], format: CatalogFormat): string {
  const books = items.map(catalogRecord);
  if (format === "json") return `${JSON.stringify({ version: 1, books }, null, 2)}\n`;

  if (format === "csv") {
    const rows = [
      ["id", "title", "authors", "series", "seriesIndex", "publisher", "publishedDate", "languages", "tags", "formats", "rating", "identifiers", "customMetadata", "description"],
      ...books.map((book) => [
        book.id,
        book.title,
        book.authors.join("; "),
        book.series ?? "",
        book.seriesIndex ?? "",
        book.publisher ?? "",
        book.publishedDate ?? "",
        book.languages?.join("; ") ?? "",
        book.tags.join("; "),
        book.formats.join("; "),
        book.rating ?? "",
        book.identifiers ?? {},
        book.customMetadata ?? {},
        book.description ?? "",
      ]),
    ];
    return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
  }

  const rows = books.map((book) => `      <tr><td>${escapeHtml(book.title)}</td><td>${escapeHtml(book.authors.join(", "))}</td><td>${escapeHtml(book.series ?? "")}</td><td>${escapeHtml(book.tags.join(", "))}</td><td>${escapeHtml(book.formats.join(", "))}</td></tr>`).join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Takio catalog</title><style>body{font:16px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:.5rem;text-align:left}</style></head><body><h1>Takio catalog</h1><table><thead><tr><th>Title</th><th>Authors</th><th>Series</th><th>Tags</th><th>Formats</th></tr></thead><tbody>\n${rows}\n    </tbody></table></body></html>\n`;
}

export async function writeCatalog(options: {
  readonly items: readonly LibraryItem[];
  readonly format: CatalogFormat;
  readonly outputPath: string;
}): Promise<{ readonly path: string; readonly books: number; readonly bytes: number; readonly sha256: string }> {
  const expectedExtension = `.${options.format}`;
  if (options.outputPath === "" || extname(options.outputPath).toLowerCase() !== expectedExtension) {
    throw new CatalogError("invalid-arguments");
  }

  const content = Buffer.from(renderCatalog(options.items, options.format));
  if (content.length > 64 * 1024 * 1024) throw new CatalogError("write-failed");

  let outputPath: string;
  try {
    const parent = await realpath(dirname(resolve(options.outputPath)));
    if (!(await stat(parent)).isDirectory()) throw new Error();
    outputPath = join(parent, basename(options.outputPath));
  } catch {
    throw new CatalogError("invalid-arguments");
  }

  let file;
  try {
    file = await open(outputPath, "wx", 0o600);
  } catch (error) {
    throw new CatalogError((error as NodeJS.ErrnoException).code === "EEXIST" ? "output-file-exists" : "write-failed");
  }
  try {
    await file.writeFile(content);
    await file.sync();
    await file.close();
  } catch {
    await file.close().catch(() => {});
    await Bun.file(outputPath).delete().catch(() => {});
    throw new CatalogError("write-failed");
  }
  return {
    path: outputPath,
    books: options.items.length,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
