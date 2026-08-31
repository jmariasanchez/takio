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
export const bookAuthorSchema = z
  .object({
    name: z.string().trim().min(1),
    sortName: z.string().trim().min(1).optional(),
  })
  .strict()
  .readonly();

export type BookAuthor = z.infer<typeof bookAuthorSchema>;

export const languageTagSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

export const bookIdentifiersSchema = z
  .record(z.string().trim().min(1), z.string().trim().min(1))
  .readonly();

export type BookIdentifiers = z.infer<typeof bookIdentifiersSchema>;

export const bookCustomMetadataSchema = z
  .record(
    z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/),
    z.string().max(16 * 1024),
  )
  .refine(
    (metadata) => Object.keys(metadata).filter((key) => key !== "takio_metadata_audit").length <= 64,
    {
      message: "Books can have at most 64 user custom metadata fields.",
    },
  )
  .refine((metadata) => Object.keys(metadata).length <= 65, {
    message: "Books can have at most one reserved Takio metadata field.",
  })
  .readonly();

export type BookCustomMetadata = z.infer<typeof bookCustomMetadataSchema>;

export const MAX_LIBRARY_TEXT_COLUMN_DEFINITIONS = 64;
export const LIBRARY_TEXT_COLUMN_RESERVED_KEY = "takio_metadata_audit";

export const libraryTextColumnKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((key) => key !== LIBRARY_TEXT_COLUMN_RESERVED_KEY, {
    message: "Reserved Takio metadata cannot be defined as a library column.",
  });

export const libraryTextColumnLabelSchema = z.string().trim().min(1).max(120);

export const libraryTextColumnDefinitionSchema = z
  .object({
    key: libraryTextColumnKeySchema,
    label: libraryTextColumnLabelSchema,
    type: z.literal("text"),
    position: z.number().int().min(0).max(MAX_LIBRARY_TEXT_COLUMN_DEFINITIONS - 1),
  })
  .strict()
  .readonly();

export type LibraryTextColumnDefinition = z.infer<typeof libraryTextColumnDefinitionSchema>;

export const libraryTextColumnDefinitionsSchema = z
  .array(libraryTextColumnDefinitionSchema)
  .max(MAX_LIBRARY_TEXT_COLUMN_DEFINITIONS)
  .superRefine((definitions, context) => {
    const keys = new Set<string>();
    for (const [index, definition] of definitions.entries()) {
      if (keys.has(definition.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "key"],
          message: "Library text column keys must be unique.",
        });
      }
      keys.add(definition.key);
      if (definition.position !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "position"],
          message: "Library text column positions must be ordered and contiguous.",
        });
      }
    }
  })
  .readonly();

export const publishedDateSchema = z
  .string()
  .regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/)
  .refine((value) => {
    if (value.length !== 10) return true;

    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= (daysInMonth[month - 1] ?? 0);
  });

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

export const BOOK_FORMAT_PROVENANCES = ["managed", "referenced"] as const;

export type BookFormatProvenance = (typeof BOOK_FORMAT_PROVENANCES)[number];

export const bookFormatSchema = z
  .object({
    sourcePath: z.string().min(1),
    format: z.enum(FORMAT_IDS),
    addedAt: z.string().datetime({ offset: true }),
    provenance: z.enum(BOOK_FORMAT_PROVENANCES),
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
    addedAt: z.string().datetime({ offset: true }),
    formats: bookFormatsSchema,
    author: optionalText,
    authors: z.array(bookAuthorSchema).min(1).readonly().optional(),
    series: optionalText,
    seriesIndex: z.number().finite().optional(),
    publisher: optionalText,
    languages: z.array(languageTagSchema).min(1).readonly().optional(),
    identifiers: bookIdentifiersSchema.optional(),
    customMetadata: bookCustomMetadataSchema.optional(),
    publishedDate: publishedDateSchema.optional(),
    rating: z.number().finite().min(0).max(10).optional(),
    description: optionalText,
    coverPath: optionalText,
    tags: tagsSchema,
    updatedAt: z.string().datetime({ offset: true }).optional(),
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
