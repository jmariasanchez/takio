import {
  BOOK_FORMAT_PROVENANCES,
  FORMAT_IDS,
  bookAuthorSchema,
  bookIdentifiersSchema,
  languageTagSchema,
  libraryItemSchema,
  publishedDateSchema,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import { z } from "zod";

export const MAX_LIBRARY_QUERY_PAGE_SIZE = 100;

export const LIBRARY_QUERY_SORT_FIELDS = [
  "title",
  "author",
  "series",
  "publishedDate",
  "rating",
  "addedAt",
  "updatedAt",
] as const;
export const LIBRARY_QUERY_SORT_DIRECTIONS = ["ascending", "descending"] as const;

/** Literal substring text; structured search grammar is intentionally outside this contract. */
export const libraryLiteralQuerySchema = z.string();

function uniqueTextValuesSchema(message: string) {
  return z
    .array(z.string().trim().min(1))
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        const comparison = value.toLowerCase();
        if (seen.has(comparison)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message });
        }
        seen.add(comparison);
      }
    })
    .readonly();
}

export const libraryQueryFiltersSchema = z
  .object({
    authors: uniqueTextValuesSchema("Authors must be unique ignoring case."),
    tags: uniqueTextValuesSchema("Tags must be unique ignoring case."),
    series: uniqueTextValuesSchema("Series must be unique ignoring case."),
    languages: z
      .array(languageTagSchema)
      .superRefine((languages, context) => {
        const seen = new Set<string>();
        for (const [index, language] of languages.entries()) {
          const comparison = language.toLowerCase();
          if (seen.has(comparison)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index],
              message: "Languages must be unique ignoring case.",
            });
          }
          seen.add(comparison);
        }
      })
      .readonly(),
    formats: z
      .array(z.enum(FORMAT_IDS))
      .refine((formats) => new Set(formats).size === formats.length, {
        message: "Formats must be unique.",
      })
      .readonly(),
  })
  .strict()
  .readonly();

export const libraryQuerySortSchema = z
  .object({
    field: z.enum(LIBRARY_QUERY_SORT_FIELDS),
    direction: z.enum(LIBRARY_QUERY_SORT_DIRECTIONS),
  })
  .strict()
  .readonly();

export const libraryQueryDefinitionSchema = z
  .object({
    query: libraryLiteralQuerySchema,
    filters: libraryQueryFiltersSchema,
    sort: libraryQuerySortSchema,
  })
  .strict()
  .readonly();

export const libraryQueryPageRequestSchema = z
  .object({
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_LIBRARY_QUERY_PAGE_SIZE),
  })
  .strict()
  .readonly();

export const queryLibraryItemsRequestSchema = z
  .object({
    query: libraryLiteralQuerySchema,
    filters: libraryQueryFiltersSchema,
    sort: libraryQuerySortSchema,
    page: libraryQueryPageRequestSchema,
  })
  .strict()
  .readonly();

export const libraryTextFacetValueSchema = z
  .object({
    value: z.string().trim().min(1),
    count: z.number().int().min(0),
  })
  .strict()
  .readonly();

export const libraryFormatFacetValueSchema = z
  .object({
    value: z.enum(FORMAT_IDS),
    count: z.number().int().min(0),
  })
  .strict()
  .readonly();

export const libraryLanguageFacetValueSchema = z
  .object({
    value: languageTagSchema,
    count: z.number().int().min(0),
  })
  .strict()
  .readonly();

/**
 * Filter values within one facet are ORed and different facets are ANDed.
 * Each facet count applies the query and other facets while excluding its own filter.
 */
export const libraryFacetCountsSchema = z
  .object({
    authors: z.array(libraryTextFacetValueSchema).readonly(),
    tags: z.array(libraryTextFacetValueSchema).readonly(),
    series: z.array(libraryTextFacetValueSchema).readonly(),
    languages: z.array(libraryLanguageFacetValueSchema).readonly(),
    formats: z.array(libraryFormatFacetValueSchema).readonly(),
  })
  .strict()
  .readonly();

export const libraryQueryPageSchema = z
  .object({
    items: z.array(libraryItemSchema).max(MAX_LIBRARY_QUERY_PAGE_SIZE).readonly(),
    total: z.number().int().min(0),
    page: libraryQueryPageRequestSchema,
    facets: libraryFacetCountsSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.items.length > result.page.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "A library query page cannot contain more items than its requested limit.",
      });
    }
    if (result.items.length > 0 && result.page.offset + result.items.length > result.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: "The total must account for every item in the returned page.",
      });
    }
  })
  .readonly();

export const savedLibraryViewDefinitionSchema = z
  .object({
    version: z.literal(1),
    query: libraryLiteralQuerySchema,
    filters: libraryQueryFiltersSchema,
    sort: libraryQuerySortSchema,
  })
  .strict()
  .readonly();

export const savedLibraryViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    definition: savedLibraryViewDefinitionSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .readonly();

export const listSavedLibraryViewsRequestSchema = z.object({}).strict().readonly();

export const saveSavedLibraryViewRequestSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    definition: savedLibraryViewDefinitionSchema,
  })
  .strict()
  .readonly();

export const removeSavedLibraryViewRequestSchema = z
  .object({ id: z.string().min(1) })
  .strict()
  .readonly();

export type LibraryQueryFilters = z.infer<typeof libraryQueryFiltersSchema>;
export type LibraryQuerySort = z.infer<typeof libraryQuerySortSchema>;
export type LibraryQueryDefinition = z.infer<typeof libraryQueryDefinitionSchema>;
export type LibraryQueryPageRequest = z.infer<typeof libraryQueryPageRequestSchema>;
export type QueryLibraryItemsRequest = z.infer<typeof queryLibraryItemsRequestSchema>;
export type LibraryTextFacetValue = z.infer<typeof libraryTextFacetValueSchema>;
export type LibraryFormatFacetValue = z.infer<typeof libraryFormatFacetValueSchema>;
export type LibraryLanguageFacetValue = z.infer<typeof libraryLanguageFacetValueSchema>;
export type LibraryFacetCounts = z.infer<typeof libraryFacetCountsSchema>;
export type LibraryQueryPage = z.infer<typeof libraryQueryPageSchema>;
export type SavedLibraryViewDefinition = z.infer<typeof savedLibraryViewDefinitionSchema>;
export type SavedLibraryView = z.infer<typeof savedLibraryViewSchema>;
export type ListSavedLibraryViewsRequest = z.infer<typeof listSavedLibraryViewsRequestSchema>;
export type SaveSavedLibraryViewRequest = z.infer<typeof saveSavedLibraryViewRequestSchema>;
export type RemoveSavedLibraryViewRequest = z.infer<typeof removeSavedLibraryViewRequestSchema>;

export const LIBRARY_STORE_ERROR_CODES = [
  "duplicate-id",
  "invalid-stored-data",
  "storage-unavailable",
  "incompatible-schema",
  "invalid-arguments",
  "duplicate-format",
  "last-format",
  "format-changed",
] as const;

export type LibraryStoreErrorCode = (typeof LIBRARY_STORE_ERROR_CODES)[number];

export interface LibraryStoreError {
  readonly code: LibraryStoreErrorCode;
}

export type LibraryStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LibraryStoreError };

export type LibraryStoreConfig = Readonly<Record<string, never>>;
export type OpenLibraryRequest = Readonly<{ config: LibraryStoreConfig }>;
export type ListLibraryItemsRequest = Readonly<Record<string, never>>;
export type GetLibraryItemRequest = Readonly<{ id: string }>;
export type AddLibraryItemRequest = Readonly<{ item: LibraryItem }>;
export type ImportLibraryItemRequest = Readonly<{ sourcePath: string; title?: string }>;
export type LibraryFormatArtifact = Readonly<{
  bytes: number;
  sha256: string;
}>;
export const libraryFormatArtifactSchema = z
  .object({
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .readonly();
const libraryFormatSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("copy"),
      path: z.string().min(1),
      expectedArtifact: libraryFormatArtifactSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reference"),
      path: z.string().min(1),
    })
    .strict(),
]).readonly();
export type AttachLibraryFormatRequest = Readonly<{
  id: string;
  source:
    | Readonly<{
        kind: "copy";
        path: string;
        expectedArtifact?: LibraryFormatArtifact;
      }>
    | Readonly<{ kind: "reference"; path: string }>;
}>;
export const replaceLibraryFormatRequestSchema = z
  .object({
    id: z.string().min(1),
    format: z.enum(FORMAT_IDS),
    expectedCurrent: z
      .object({
        sourcePath: z.string().min(1),
        addedAt: z.string().datetime(),
        provenance: z.enum(BOOK_FORMAT_PROVENANCES),
      })
      .strict()
      .readonly(),
    source: libraryFormatSourceSchema,
  })
  .strict()
  .readonly();
export type ReplaceLibraryFormatRequest = z.infer<typeof replaceLibraryFormatRequestSchema>;
export type RemoveLibraryFormatRequest = Readonly<{ id: string; format: FormatId }>;
export type RemoveLibraryItemRequest = Readonly<{ id: string }>;
const nullableLibraryMetadataTextSchema = z.string().trim().min(1).nullable().optional();

export const libraryMetadataPatchSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    author: nullableLibraryMetadataTextSchema,
    authors: z.array(bookAuthorSchema).min(1).readonly().nullable().optional(),
    series: nullableLibraryMetadataTextSchema,
    seriesIndex: z.number().finite().nullable().optional(),
    publisher: nullableLibraryMetadataTextSchema,
    languages: z.array(languageTagSchema).min(1).readonly().nullable().optional(),
    identifiers: bookIdentifiersSchema.nullable().optional(),
    publishedDate: publishedDateSchema.nullable().optional(),
    rating: z.number().finite().min(0).max(10).nullable().optional(),
    description: nullableLibraryMetadataTextSchema,
    tags: uniqueTextValuesSchema("Tags must be unique ignoring case."),
  })
  .strict()
  .readonly();

export type LibraryMetadataPatch = z.infer<typeof libraryMetadataPatchSchema>;
export type UpdateLibraryItemRequest = Readonly<{
  id: string;
  patch: LibraryMetadataPatch;
}>;
export type SetLibraryCoverRequest = Readonly<{ id: string; sourcePath: string }>;
export type RemoveLibraryCoverRequest = Readonly<{ id: string }>;
export type SearchLibraryItemsRequest = Readonly<{ query: string }>;

export type OpenLibraryResult = LibraryStoreResult<null>;
export type ListLibraryItemsResult = LibraryStoreResult<readonly LibraryItem[]>;
export type GetLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type AddLibraryItemResult = LibraryStoreResult<LibraryItem>;
export type ImportLibraryItemResult = LibraryStoreResult<LibraryItem>;
export type AttachLibraryFormatResult = LibraryStoreResult<LibraryItem | null>;
export type ReplaceLibraryFormatResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type RemoveLibraryFormatResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type RemoveLibraryItemResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type UpdateLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type SetLibraryCoverResult = LibraryStoreResult<LibraryItem | null>;
export type RemoveLibraryCoverResult = LibraryStoreResult<LibraryItem | null>;
export type SearchLibraryItemsResult = LibraryStoreResult<readonly LibraryItem[]>;
export type QueryLibraryItemsResult = LibraryStoreResult<LibraryQueryPage>;
export type ListSavedLibraryViewsResult = LibraryStoreResult<readonly SavedLibraryView[]>;
export type SaveSavedLibraryViewResult = LibraryStoreResult<SavedLibraryView>;
export type RemoveSavedLibraryViewResult = LibraryStoreResult<SavedLibraryView | null>;

export type LibraryListWireResult = LibraryStoreResult<{
  readonly items: readonly LibraryItem[];
}>;
export type LibraryImportWireResult = LibraryStoreResult<{ readonly item: LibraryItem }>;
export type LibraryRemoveWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type LibraryReplaceFormatWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type LibraryUpdateWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibraryCoverWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibrarySearchWireResult = LibraryStoreResult<{
  readonly items: readonly LibraryItem[];
}>;
export type LibraryQueryWireResult = LibraryStoreResult<LibraryQueryPage>;
export type LibrarySavedViewsWireResult = LibraryStoreResult<{
  readonly views: readonly SavedLibraryView[];
}>;
export type LibrarySavedViewWireResult = LibraryStoreResult<{
  readonly view: SavedLibraryView | null;
}>;

export interface LibraryQueryStore {
  query(request: QueryLibraryItemsRequest): Promise<QueryLibraryItemsResult>;
}

export interface SavedLibraryViewStore {
  listSavedViews(request: ListSavedLibraryViewsRequest): Promise<ListSavedLibraryViewsResult>;
  saveSavedView(request: SaveSavedLibraryViewRequest): Promise<SaveSavedLibraryViewResult>;
  removeSavedView(request: RemoveSavedLibraryViewRequest): Promise<RemoveSavedLibraryViewResult>;
}

export interface LibraryFormatReplacementStore {
  replaceFormat(request: ReplaceLibraryFormatRequest): Promise<ReplaceLibraryFormatResult>;
}

export interface LibraryStore {
  open(request: OpenLibraryRequest): Promise<OpenLibraryResult>;
  list(request: ListLibraryItemsRequest): Promise<ListLibraryItemsResult>;
  get(request: GetLibraryItemRequest): Promise<GetLibraryItemResult>;
  add(request: AddLibraryItemRequest): Promise<AddLibraryItemResult>;
  import(request: ImportLibraryItemRequest): Promise<ImportLibraryItemResult>;
  attachFormat(request: AttachLibraryFormatRequest): Promise<AttachLibraryFormatResult>;
  removeFormat(request: RemoveLibraryFormatRequest): Promise<RemoveLibraryFormatResult>;
  update(request: UpdateLibraryItemRequest): Promise<UpdateLibraryItemResult>;
  setCover(request: SetLibraryCoverRequest): Promise<SetLibraryCoverResult>;
  removeCover(request: RemoveLibraryCoverRequest): Promise<RemoveLibraryCoverResult>;
  search(request: SearchLibraryItemsRequest): Promise<SearchLibraryItemsResult>;
  remove(request: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult>;
}
