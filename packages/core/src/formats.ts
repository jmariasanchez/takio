export const FORMAT_IDS = [
  "epub",
  "pdf",
  "mobi",
  "azw3",
  "docx",
  "html",
  "txt",
  "cbz",
] as const;

export type FormatId = (typeof FORMAT_IDS)[number];

export interface FormatDefinition {
  id: FormatId;
  label: string;
  extensions: readonly string[];
  kind: "ebook" | "document" | "comic";
}

export const FORMAT_CATALOG: readonly FormatDefinition[] = [
  { id: "epub", label: "EPUB", extensions: [".epub"], kind: "ebook" },
  { id: "pdf", label: "PDF", extensions: [".pdf"], kind: "document" },
  { id: "mobi", label: "MOBI", extensions: [".mobi"], kind: "ebook" },
  { id: "azw3", label: "AZW3", extensions: [".azw3"], kind: "ebook" },
  { id: "docx", label: "DOCX", extensions: [".docx"], kind: "document" },
  { id: "html", label: "HTML", extensions: [".html", ".htm"], kind: "document" },
  { id: "txt", label: "Plain text", extensions: [".txt"], kind: "document" },
  { id: "cbz", label: "Comic book archive", extensions: [".cbz"], kind: "comic" },
];

export function detectFormat(fileName: string): FormatId | undefined {
  const lowerCaseName = fileName.toLowerCase();
  return FORMAT_CATALOG.find((format) =>
    format.extensions.some((extension) => lowerCaseName.endsWith(extension)),
  )?.id;
}
