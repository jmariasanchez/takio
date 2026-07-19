export const DESTINATION_KINDS = ["kindle", "kobo", "generic"] as const;

export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export interface Destination {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: DestinationKind;
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
