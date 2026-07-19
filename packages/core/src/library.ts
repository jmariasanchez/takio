import { z } from "zod";

import { FORMAT_IDS } from "./formats.js";

export function normalizeTags(tags: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const display = tag.trim().replace(/\s+/g, " ");
    const comparison = display.toLowerCase();
    if (display.length === 0 || seen.has(comparison)) {
      throw new TypeError("Tags must be nonempty and unique ignoring case.");
    }
    seen.add(comparison);
    normalized.push(display);
  }

  return normalized;
}

const optionalText = z.string().trim().min(1).optional();
const tagsSchema = z
  .array(z.string())
  .transform((tags, context) => {
    try {
      return normalizeTags(tags);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid tags" });
      return z.NEVER;
    }
  })
  .readonly()
  .default([]);

export const bookFormatSchema = z
  .object({
    sourcePath: z.string().min(1),
    format: z.enum(FORMAT_IDS),
    addedAt: z.string().datetime(),
  })
  .strict()
  .readonly();

export type BookFormat = z.infer<typeof bookFormatSchema>;

export const bookFormatsSchema = z
  .array(bookFormatSchema)
  .min(1)
  .superRefine((formats, context) => {
    const seen = new Set<string>();
    for (const [index, bookFormat] of formats.entries()) {
      if (seen.has(bookFormat.format)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "format"],
          message: "Book formats must be unique.",
        });
      }
      seen.add(bookFormat.format);
    }
  })
  .readonly();

export const libraryItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    sourcePath: z.string().min(1),
    format: z.enum(FORMAT_IDS),
    addedAt: z.string().datetime(),
    formats: bookFormatsSchema,
    author: optionalText,
    description: optionalText,
    coverPath: optionalText,
    tags: tagsSchema,
    updatedAt: z.string().datetime().optional(),
  })
  .superRefine((item, context) => {
    const primaryFormat = item.formats[0];
    if (
      primaryFormat &&
      (primaryFormat.sourcePath !== item.sourcePath || primaryFormat.format !== item.format)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formats", 0],
        message: "The primary format must match the legacy source path and format aliases.",
      });
    }
  })
  .readonly();

export type LibraryItem = z.infer<typeof libraryItemSchema>;

export class InMemoryLibraryRepository {
  readonly #items = new Map<string, LibraryItem>();

  add(item: LibraryItem): void {
    const parsed = libraryItemSchema.parse(item);

    if (this.#items.has(parsed.id)) {
      throw new Error(`Library item '${parsed.id}' already exists.`);
    }

    this.#items.set(parsed.id, parsed);
  }

  list(): LibraryItem[] {
    return [...this.#items.values()];
  }

  get(id: string): LibraryItem | undefined {
    return this.#items.get(id);
  }

  remove(id: string): LibraryItem | undefined {
    const item = this.#items.get(id);
    this.#items.delete(id);
    return item;
  }
}
