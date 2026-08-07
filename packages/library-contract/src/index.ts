import {
  BOOK_FORMAT_PROVENANCES,
  FORMAT_IDS,
  bookAuthorSchema,
  bookCustomMetadataSchema,
  bookIdentifiersSchema,
  languageTagSchema,
  libraryItemSchema,
  publishedDateSchema,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import { z } from "zod";

export const MAX_LIBRARY_QUERY_PAGE_SIZE = 100;
export const MAX_LIBRARY_IMPORT_ROOTS = 256;
export const MAX_LIBRARY_EXPORT_ITEMS = 256;
export const MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH = 120;
export const DUPLICATE_REVIEW_DISPOSITIONS = ["unreviewed", "kept-both"] as const;
export const LIBRARY_IMPORT_SKIPPED_REASONS = [
  "unsupported-format",
  "symbolic-link",
  "unsupported-file-type",
] as const;
export const LIBRARY_IMPORT_DUPLICATE_REASONS = [
  "existing-library",
  "earlier-in-request",
] as const;
export const LIBRARY_IMPORT_FAILURE_CODES = [
  "not-found",
  "unreadable",
  "source-changed",
  "storage-unavailable",
  "invalid-title",
] as const;
export const LIBRARY_EXPORT_SKIPPED_REASONS = ["destination-exists"] as const;
export const LIBRARY_EXPORT_FAILURE_CODES = [
  "item-not-found",
  "source-unavailable",
  "source-changed",
  "destination-unavailable",
  "metadata-write-failed",
] as const;
export const LIBRARY_EXPORT_METADATA_STATES = [
  "embedded",
  "unsupported",
  "backend-unavailable",
] as const;
export const LIBRARY_EXPORT_FILE_NAME_TEMPLATES = ["title", "author-title"] as const;

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

export const listLibraryTrashRequestSchema = z
  .object({ page: libraryQueryPageRequestSchema })
  .strict()
  .readonly();

export const libraryTrashPageSchema = z
  .object({
    items: z.array(libraryItemSchema).max(MAX_LIBRARY_QUERY_PAGE_SIZE).readonly(),
    total: z.number().int().min(0),
    page: libraryQueryPageRequestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.items.length > result.page.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "A trash page cannot contain more items than its requested limit.",
      });
    }
    if (result.items.length > 0 && result.page.offset + result.items.length > result.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: "The total must account for every item in the returned trash page.",
      });
    }
  })
  .readonly();

const duplicateReviewTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const duplicateSignalSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("same-content"),
        leftFormat: z.enum(FORMAT_IDS),
        rightFormat: z.enum(FORMAT_IDS),
        bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("same-identifier"),
        scheme: z.string().trim().min(1),
        value: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("same-title-author"),
        title: z.string().trim().min(1),
        author: z.string().trim().min(1),
      })
      .strict(),
  ])
  .readonly();

export const duplicateCandidateSchema = z
  .object({
    left: libraryItemSchema,
    right: libraryItemSchema,
    signals: z.array(duplicateSignalSchema).min(1).readonly(),
    reviewToken: duplicateReviewTokenSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.left.id >= candidate.right.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["right", "id"],
        message: "Duplicate candidate item IDs must be distinct and canonically ordered.",
      });
    }
  })
  .readonly();

export const listDuplicateCandidatesRequestSchema = z
  .object({
    page: libraryQueryPageRequestSchema,
    disposition: z.enum(DUPLICATE_REVIEW_DISPOSITIONS),
  })
  .strict()
  .readonly();

const duplicateScanSummarySchema = z
  .object({
    filesHashed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    fingerprintsReused: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    unreadableFormats: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();

export const duplicateCandidatePageSchema = z
  .object({
    candidates: z.array(duplicateCandidateSchema).max(MAX_LIBRARY_QUERY_PAGE_SIZE).readonly(),
    total: z.number().int().min(0),
    page: libraryQueryPageRequestSchema,
    scan: duplicateScanSummarySchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.candidates.length > result.page.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "A duplicate candidate page cannot contain more pairs than its requested limit.",
      });
    }
    if (
      result.candidates.length > 0 &&
      result.page.offset + result.candidates.length > result.total
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total"],
        message: "The total must account for every pair in the returned page.",
      });
    }
  })
  .readonly();

const duplicatePairReviewRequestSchema = z
  .object({
    leftId: z.string().min(1),
    rightId: z.string().min(1),
    reviewToken: duplicateReviewTokenSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.leftId >= request.rightId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rightId"],
        message: "Duplicate pair item IDs must be distinct and canonically ordered.",
      });
    }
  })
  .readonly();

export const keepDuplicatePairRequestSchema = duplicatePairReviewRequestSchema;
export const reopenDuplicatePairRequestSchema = duplicatePairReviewRequestSchema;

export const savedLibraryViewDefinitionSchema = z
  .object({
    version: z.literal(1),
    query: libraryLiteralQuerySchema,
    filters: libraryQueryFiltersSchema,
    sort: libraryQuerySortSchema,
  })
  .strict()
  .readonly();

const savedLibraryViewNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SAVED_LIBRARY_VIEW_NAME_LENGTH);

export const savedLibraryViewSchema = z
  .object({
    id: z.string().min(1),
    name: savedLibraryViewNameSchema,
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
    name: savedLibraryViewNameSchema,
    definition: savedLibraryViewDefinitionSchema,
  })
  .strict()
  .readonly();

export const removeSavedLibraryViewRequestSchema = z
  .object({ id: z.string().min(1) })
  .strict()
  .readonly();

const libraryItemLifecycleRequestSchema = z
  .object({ id: z.string().min(1) })
  .strict()
  .readonly();

export const trashLibraryItemRequestSchema = libraryItemLifecycleRequestSchema;
export const restoreLibraryItemRequestSchema = libraryItemLifecycleRequestSchema;
export const purgeLibraryItemRequestSchema = libraryItemLifecycleRequestSchema;

const libraryImportPathSchema = z
  .string()
  .min(1)
  .refine((path) => path.trim().length > 0, { message: "Import paths must not be blank." });

export const importLibraryItemsRequestSchema = z
  .object({
    roots: z
      .array(libraryImportPathSchema)
      .min(1)
      .max(MAX_LIBRARY_IMPORT_ROOTS)
      .readonly(),
  })
  .strict()
  .readonly();

const importedLibraryEntrySchema = z
  .object({
    status: z.literal("imported"),
    sourcePath: libraryImportPathSchema,
    item: libraryItemSchema,
  })
  .strict();

const skippedLibraryImportEntrySchema = z
  .object({
    status: z.literal("skipped"),
    sourcePath: libraryImportPathSchema,
    reason: z.enum(LIBRARY_IMPORT_SKIPPED_REASONS),
  })
  .strict();

const duplicateLibraryImportEntrySchema = z
  .object({
    status: z.literal("duplicate"),
    sourcePath: libraryImportPathSchema,
    existing: z
      .object({
        itemId: z.string().min(1),
        format: z.enum(FORMAT_IDS),
      })
      .strict()
      .readonly(),
    reason: z.enum(LIBRARY_IMPORT_DUPLICATE_REASONS),
  })
  .strict();

const failedLibraryImportEntrySchema = z
  .object({
    status: z.literal("failed"),
    sourcePath: libraryImportPathSchema,
    code: z.enum(LIBRARY_IMPORT_FAILURE_CODES),
  })
  .strict();

export const libraryImportEntryOutcomeSchema = z
  .discriminatedUnion("status", [
    importedLibraryEntrySchema,
    skippedLibraryImportEntrySchema,
    duplicateLibraryImportEntrySchema,
    failedLibraryImportEntrySchema,
  ])
  .readonly();

const libraryImportCountsSchema = z
  .object({
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    imported: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    skipped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    duplicates: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    failed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();

export const libraryImportReportSchema = z
  .object({
    outcomes: z.array(libraryImportEntryOutcomeSchema).readonly(),
    counts: libraryImportCountsSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const expected = {
      total: report.outcomes.length,
      imported: report.outcomes.filter(({ status }) => status === "imported").length,
      skipped: report.outcomes.filter(({ status }) => status === "skipped").length,
      duplicates: report.outcomes.filter(({ status }) => status === "duplicate").length,
      failed: report.outcomes.filter(({ status }) => status === "failed").length,
    } as const;

    for (const count of Object.keys(expected) as (keyof typeof expected)[]) {
      if (report.counts[count] !== expected[count]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counts", count],
          message: `Import ${count} must match the reported outcomes.`,
        });
      }
    }
  })
  .readonly();

const libraryExportPathSchema = z
  .string()
  .min(1)
  .refine((path) => path.trim().length > 0, { message: "Export paths must not be blank." });

const libraryExportItemIdSchema = z
  .string()
  .min(1)
  .refine((id) => id.trim().length > 0, { message: "Export item ids must not be blank." });

export const exportLibraryItemsRequestSchema = z
  .object({
    ids: z
      .array(libraryExportItemIdSchema)
      .min(1)
      .max(MAX_LIBRARY_EXPORT_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Export item ids must be unique.",
      })
      .readonly(),
    destinationPath: libraryExportPathSchema,
    fileNameTemplate: z.enum(LIBRARY_EXPORT_FILE_NAME_TEMPLATES).optional(),
  })
  .strict()
  .readonly();

const libraryExportTargetShape = {
  itemId: libraryExportItemIdSchema,
  format: z.enum(FORMAT_IDS),
  provenance: z.enum(BOOK_FORMAT_PROVENANCES),
  destinationPath: libraryExportPathSchema,
} as const;

const exportedLibraryEntrySchema = z
  .object({
    status: z.literal("exported"),
    ...libraryExportTargetShape,
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    metadata: z.enum(LIBRARY_EXPORT_METADATA_STATES).optional(),
  })
  .strict();

const skippedLibraryExportEntrySchema = z
  .object({
    status: z.literal("skipped"),
    ...libraryExportTargetShape,
    reason: z.enum(LIBRARY_EXPORT_SKIPPED_REASONS),
  })
  .strict();

const missingLibraryExportItemSchema = z
  .object({
    status: z.literal("failed"),
    itemId: libraryExportItemIdSchema,
    code: z.literal("item-not-found"),
  })
  .strict();

const failedLibraryExportEntrySchema = z
  .object({
    status: z.literal("failed"),
    ...libraryExportTargetShape,
    code: z.enum([
      "source-unavailable",
      "source-changed",
      "destination-unavailable",
      "metadata-write-failed",
    ]),
  })
  .strict();

export const libraryExportEntryOutcomeSchema = z
  .union([
    exportedLibraryEntrySchema,
    skippedLibraryExportEntrySchema,
    missingLibraryExportItemSchema,
    failedLibraryExportEntrySchema,
  ])
  .readonly();

const libraryExportCountsSchema = z
  .object({
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    exported: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    skipped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    failed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();

export const libraryExportReportSchema = z
  .object({
    outcomes: z.array(libraryExportEntryOutcomeSchema).readonly(),
    counts: libraryExportCountsSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const expected = {
      total: report.outcomes.length,
      exported: report.outcomes.filter(({ status }) => status === "exported").length,
      skipped: report.outcomes.filter(({ status }) => status === "skipped").length,
      failed: report.outcomes.filter(({ status }) => status === "failed").length,
    } as const;

    for (const count of Object.keys(expected) as (keyof typeof expected)[]) {
      if (report.counts[count] !== expected[count]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counts", count],
          message: `Export ${count} must match the reported outcomes.`,
        });
      }
    }
  })
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
export type ListLibraryTrashRequest = z.infer<typeof listLibraryTrashRequestSchema>;
export type LibraryTrashPage = z.infer<typeof libraryTrashPageSchema>;
export type DuplicateSignal = z.infer<typeof duplicateSignalSchema>;
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;
export type ListDuplicateCandidatesRequest = z.infer<typeof listDuplicateCandidatesRequestSchema>;
export type DuplicateCandidatePage = z.infer<typeof duplicateCandidatePageSchema>;
export type KeepDuplicatePairRequest = z.infer<typeof keepDuplicatePairRequestSchema>;
export type ReopenDuplicatePairRequest = z.infer<typeof reopenDuplicatePairRequestSchema>;
export type SavedLibraryViewDefinition = z.infer<typeof savedLibraryViewDefinitionSchema>;
export type SavedLibraryView = z.infer<typeof savedLibraryViewSchema>;
export type ListSavedLibraryViewsRequest = z.infer<typeof listSavedLibraryViewsRequestSchema>;
export type SaveSavedLibraryViewRequest = z.infer<typeof saveSavedLibraryViewRequestSchema>;
export type RemoveSavedLibraryViewRequest = z.infer<typeof removeSavedLibraryViewRequestSchema>;
export type TrashLibraryItemRequest = z.infer<typeof trashLibraryItemRequestSchema>;
export type RestoreLibraryItemRequest = z.infer<typeof restoreLibraryItemRequestSchema>;
export type PurgeLibraryItemRequest = z.infer<typeof purgeLibraryItemRequestSchema>;
export type ImportLibraryItemsRequest = z.infer<typeof importLibraryItemsRequestSchema>;
export type LibraryImportEntryOutcome = z.infer<typeof libraryImportEntryOutcomeSchema>;
export type LibraryImportReport = z.infer<typeof libraryImportReportSchema>;
export type ExportLibraryItemsRequest = z.infer<typeof exportLibraryItemsRequestSchema>;
export type LibraryExportEntryOutcome = z.infer<typeof libraryExportEntryOutcomeSchema>;
export type LibraryExportReport = z.infer<typeof libraryExportReportSchema>;

export const LIBRARY_STORE_ERROR_CODES = [
  "duplicate-id",
  "invalid-stored-data",
  "storage-unavailable",
  "incompatible-schema",
  "invalid-arguments",
  "duplicate-format",
  "last-format",
  "format-changed",
  "not-trashed",
  "stale-review",
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
    customMetadata: bookCustomMetadataSchema.nullable().optional(),
    publishedDate: publishedDateSchema.nullable().optional(),
    rating: z.number().finite().min(0).max(10).nullable().optional(),
    description: nullableLibraryMetadataTextSchema,
    tags: uniqueTextValuesSchema("Tags must be unique ignoring case.").optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "At least one metadata field is required.",
  })
  .readonly();

export const mergeDuplicatePairRequestSchema = z
  .object({
    targetId: z.string().min(1),
    sourceId: z.string().min(1),
    reviewToken: duplicateReviewTokenSchema,
    metadata: libraryMetadataPatchSchema,
    addSourceFormats: z
      .array(z.enum(FORMAT_IDS))
      .refine((formats) => new Set(formats).size === formats.length, {
        message: "Source formats must be unique.",
      })
      .readonly(),
    cover: z.enum(["target", "source", "none"]),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.targetId === request.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceId"],
        message: "A duplicate merge source must differ from its target.",
      });
    }
  })
  .readonly();

export type LibraryMetadataPatch = z.infer<typeof libraryMetadataPatchSchema>;
export type MergeDuplicatePairRequest = z.infer<typeof mergeDuplicatePairRequestSchema>;
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
export type ImportLibraryItemsResult = LibraryStoreResult<LibraryImportReport>;
export type ExportLibraryItemsResult = LibraryStoreResult<LibraryExportReport>;
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
export type ListLibraryTrashResult = LibraryStoreResult<LibraryTrashPage>;
export type TrashLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type RestoreLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type PurgeLibraryItemResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type ListDuplicateCandidatesResult = LibraryStoreResult<DuplicateCandidatePage>;
export type KeepDuplicatePairResult = LibraryStoreResult<null>;
export type ReopenDuplicatePairResult = LibraryStoreResult<null>;
export type MergeDuplicatePairResult = LibraryStoreResult<{
  readonly target: LibraryItem;
  readonly trashedSource: LibraryItem;
  readonly cleanupPending: boolean;
}>;

export type LibraryListWireResult = LibraryStoreResult<{
  readonly items: readonly LibraryItem[];
}>;
export type LibraryImportWireResult = LibraryStoreResult<{ readonly item: LibraryItem }>;
export type LibraryBatchImportWireResult = ImportLibraryItemsResult;
export type LibraryExportWireResult = ExportLibraryItemsResult;
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
export type LibraryTrashWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibraryTrashListWireResult = LibraryStoreResult<LibraryTrashPage>;
export type LibraryRestoreWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibraryPurgeWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type LibraryDuplicateCandidatesWireResult = ListDuplicateCandidatesResult;
export type LibraryDuplicateDispositionWireResult =
  KeepDuplicatePairResult | ReopenDuplicatePairResult;
export type LibraryDuplicateMergeWireResult = MergeDuplicatePairResult;

export interface LibraryQueryStore {
  /** Returns active items only; trashed items do not contribute to items, totals, or facets. */
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

export interface LibraryBatchImportStore {
  importMany(request: ImportLibraryItemsRequest): Promise<ImportLibraryItemsResult>;
}

export interface LibraryExportStore {
  exportMany(request: ExportLibraryItemsRequest): Promise<ExportLibraryItemsResult>;
}

export interface LibraryDuplicateReviewStore {
  /** Lists active-item candidate pairs in deterministic signal, title, and id order. */
  listDuplicateCandidates(
    request: ListDuplicateCandidatesRequest,
  ): Promise<ListDuplicateCandidatesResult>;
  /** Suppresses this pair only while the reviewed evidence token remains current. */
  keepDuplicatePair(request: KeepDuplicatePairRequest): Promise<KeepDuplicatePairResult>;
  /** Makes a previously kept pair reviewable again without changing either library item. */
  reopenDuplicatePair(request: ReopenDuplicatePairRequest): Promise<ReopenDuplicatePairResult>;
  /**
   * Applies the explicit target patch, copies selected missing formats, and moves the intact source
   * item to trash. Implementations reject changed evidence with `stale-review` and never purge.
   */
  mergeDuplicatePair(request: MergeDuplicatePairRequest): Promise<MergeDuplicatePairResult>;
}

export interface LibraryItemTrashStore {
  /**
   * Lists trashed items in pages of at most 100, newest trash transition first and then by id.
   */
  listTrash(request: ListLibraryTrashRequest): Promise<ListLibraryTrashResult>;
  /**
   * Moves an active item to trash. Repeating the request returns the already-trashed item;
   * a missing or previously purged id succeeds with null.
   */
  trash(request: TrashLibraryItemRequest): Promise<TrashLibraryItemResult>;
  /**
   * Restores a trashed item. Repeating the request returns the already-active item;
   * a missing or previously purged id succeeds with null.
   */
  restore(request: RestoreLibraryItemRequest): Promise<RestoreLibraryItemResult>;
  /**
   * Permanently removes a trashed item. Active items fail with `not-trashed`;
   * repeating a successful purge returns a null item with no cleanup pending. The cleanup flag
   * reports Takio-managed files that still await deletion.
   */
  purge(request: PurgeLibraryItemRequest): Promise<PurgeLibraryItemResult>;
}

export interface LibraryStore {
  open(request: OpenLibraryRequest): Promise<OpenLibraryResult>;
  /** Returns active items only; trashed items are excluded. */
  list(request: ListLibraryItemsRequest): Promise<ListLibraryItemsResult>;
  get(request: GetLibraryItemRequest): Promise<GetLibraryItemResult>;
  add(request: AddLibraryItemRequest): Promise<AddLibraryItemResult>;
  import(request: ImportLibraryItemRequest): Promise<ImportLibraryItemResult>;
  attachFormat(request: AttachLibraryFormatRequest): Promise<AttachLibraryFormatResult>;
  removeFormat(request: RemoveLibraryFormatRequest): Promise<RemoveLibraryFormatResult>;
  update(request: UpdateLibraryItemRequest): Promise<UpdateLibraryItemResult>;
  setCover(request: SetLibraryCoverRequest): Promise<SetLibraryCoverResult>;
  removeCover(request: RemoveLibraryCoverRequest): Promise<RemoveLibraryCoverResult>;
  /** Searches active items only; trashed items are excluded. */
  search(request: SearchLibraryItemsRequest): Promise<SearchLibraryItemsResult>;
  remove(request: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult>;
}
