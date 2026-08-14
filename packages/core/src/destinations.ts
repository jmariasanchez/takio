import type { FormatId } from "./formats.js";

export const DESTINATION_KINDS = ["kindle", "kobo", "generic"] as const;
export const DESTINATION_FEATURES = ["koreader"] as const;

export type DestinationKind = (typeof DESTINATION_KINDS)[number];
export type DestinationFeature = (typeof DESTINATION_FEATURES)[number];

export interface Destination {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: DestinationKind;
  readonly features?: readonly DestinationFeature[];
  readonly freeBytes?: number;
}

export function classifyDestinationKind(
  rootEntries: readonly string[],
): DestinationKind {
  const entries = new Set(rootEntries.map((entry) => entry.toLowerCase()));

  if (entries.has("documents") && entries.has("system")) {
    return "kindle";
  }

  if (entries.has(".kobo")) {
    return "kobo";
  }

  return "generic";
}

export function defaultDestinationSubdir(kind: DestinationKind): string {
  return kind === "kindle" ? "documents" : "";
}

export function destinationFormatPreferences(
  kind: DestinationKind,
  features: readonly DestinationFeature[] = [],
): readonly FormatId[] {
  if (kind === "kobo") return ["kepub", "epub", "pdf", "cbz"];
  if (kind === "kindle" && features.includes("koreader")) {
    return ["epub", "pdf", "cbz", "azw3", "mobi", "txt"];
  }
  if (kind === "kindle") return ["azw3", "mobi", "pdf", "txt"];
  return [];
}

export function destinationBookFileName(
  title: string,
  author: string | undefined,
  extension: string,
): string {
  const safeTitle = sanitizeDestinationFileName(title.replace(/[\\/]/g, "")) ?? "Untitled";
  const safeAuthor = author
    ? sanitizeDestinationFileName(author.replace(/[\\/]/g, "")) ?? undefined
    : undefined;
  const stem = safeAuthor ? `${safeAuthor} - ${safeTitle}` : safeTitle;
  const sanitized = sanitizeDestinationFileName(`${stem}.${extension}`) ?? `Untitled.${extension}`;
  if (sanitized.length <= 180) return sanitized;

  const suffix = `.${extension}`;
  return `${sanitized.slice(0, 180 - suffix.length).trimEnd()}${suffix}`;
}

export function sanitizeDestinationFileName(name: string): string | null {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const sanitized = basename.replace(
    /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g,
    "",
  );

  return sanitized === "" || sanitized === "." || sanitized === ".."
    ? null
    : sanitized;
}
