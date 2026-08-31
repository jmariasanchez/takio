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
export const LIBRARY_IMPORT_MODES = ["copy", "move"] as const;
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
  "cross-device-move",
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
export const LIBRARY_EXPORT_DIRECTORY_TEMPLATES = ["flat", "author", "series"] as const;
export const LIBRARY_HEALTH_ERROR_CODES = [
  "invalid-arguments",
  "storage-unavailable",
  "incompatible-schema",
  "integrity-failed",
  "destination-exists",
  "backup-failed",
  "diagnostics-failed",
] as const;
export const LIBRARY_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;
export const MAX_LIBRARY_DIAGNOSTIC_BUNDLE_BYTES = 1024 * 1024;

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
export const LIBRARY_QUERY_SYNTAXES = ["literal", "structured-v1"] as const;
export const MAX_LIBRARY_QUERY_TEXT_LENGTH = 1024;

export const libraryLiteralQuerySchema = z.string().max(MAX_LIBRARY_QUERY_TEXT_LENGTH);
export const libraryQuerySyntaxSchema = z.enum(LIBRARY_QUERY_SYNTAXES);

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
    querySyntax: libraryQuerySyntaxSchema.optional(),
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

const savedLibraryViewIdSchema = z.string().trim().min(1).max(256);

export const queryLibraryItemsRequestSchema = z
  .object({
    virtualLibraryId: savedLibraryViewIdSchema.optional(),
    querySyntax: libraryQuerySyntaxSchema.optional(),
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
    querySyntax: libraryQuerySyntaxSchema.optional(),
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
    id: savedLibraryViewIdSchema,
    name: savedLibraryViewNameSchema,
    definition: savedLibraryViewDefinitionSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .readonly();

export const listSavedLibraryViewsRequestSchema = z.object({}).strict().readonly();

export const saveSavedLibraryViewRequestSchema = z
  .object({
    id: savedLibraryViewIdSchema,
    name: savedLibraryViewNameSchema,
    definition: savedLibraryViewDefinitionSchema,
  })
  .strict()
  .readonly();

export const removeSavedLibraryViewRequestSchema = z
  .object({ id: savedLibraryViewIdSchema })
  .strict()
  .readonly();

// Saved views are the persisted definitions behind virtual libraries. Keep the
// original names for protocol compatibility while exposing the product-domain
// vocabulary to new callers.
export const virtualLibraryDefinitionSchema = savedLibraryViewDefinitionSchema;
export const virtualLibrarySchema = savedLibraryViewSchema;
export const listVirtualLibrariesRequestSchema = listSavedLibraryViewsRequestSchema;
export const saveVirtualLibraryRequestSchema = saveSavedLibraryViewRequestSchema;
export const removeVirtualLibraryRequestSchema = removeSavedLibraryViewRequestSchema;

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
    mode: z.enum(LIBRARY_IMPORT_MODES).optional(),
  })
  .strict()
  .readonly();

const importedLibraryEntrySchema = z
  .object({
    status: z.literal("imported"),
    sourcePath: libraryImportPathSchema,
    item: libraryItemSchema,
    sourceCleanupPending: z.boolean().optional(),
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
    sourceCleanupPending: z.boolean().optional(),
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
    directoryTemplate: z.enum(LIBRARY_EXPORT_DIRECTORY_TEMPLATES).optional(),
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
export type LibraryQuerySyntax = z.infer<typeof libraryQuerySyntaxSchema>;
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
export type VirtualLibraryDefinition = SavedLibraryViewDefinition;
export type VirtualLibrary = SavedLibraryView;
export type ListVirtualLibrariesRequest = ListSavedLibraryViewsRequest;
export type SaveVirtualLibraryRequest = SaveSavedLibraryViewRequest;
export type RemoveVirtualLibraryRequest = RemoveSavedLibraryViewRequest;
export type TrashLibraryItemRequest = z.infer<typeof trashLibraryItemRequestSchema>;
export type RestoreLibraryItemRequest = z.infer<typeof restoreLibraryItemRequestSchema>;
export type PurgeLibraryItemRequest = z.infer<typeof purgeLibraryItemRequestSchema>;
export type ImportLibraryItemsRequest = z.infer<typeof importLibraryItemsRequestSchema>;
export type LibraryImportEntryOutcome = z.infer<typeof libraryImportEntryOutcomeSchema>;
export type LibraryImportReport = z.infer<typeof libraryImportReportSchema>;
export type ExportLibraryItemsRequest = z.infer<typeof exportLibraryItemsRequestSchema>;
export type LibraryExportEntryOutcome = z.infer<typeof libraryExportEntryOutcomeSchema>;
export type LibraryExportReport = z.infer<typeof libraryExportReportSchema>;

export const libraryIntegrityReportSchema = z
  .object({
    schemaVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    items: z
      .object({
        total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        active: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        trashed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .readonly(),
    formats: z
      .object({
        total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        managed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        referenced: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.items.active + report.items.trashed !== report.items.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", "total"],
        message: "Item counts must add up to the total.",
      });
    }
    if (report.formats.managed + report.formats.referenced !== report.formats.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formats", "total"],
        message: "Format counts must add up to the total.",
      });
    }
  })
  .readonly();

export const libraryHealthLocationSchema = z
  .object({
    rootPath: z.string().min(1),
    databasePath: z.string().min(1),
  })
  .strict()
  .readonly();

export const libraryHealthVerifyValueSchema = z
  .object({ report: libraryIntegrityReportSchema })
  .strict()
  .readonly();

export const libraryHealthBackupRequestSchema = z
  .object({ destinationPath: z.string().trim().min(1) })
  .strict()
  .readonly();

export const libraryHealthBackupValueSchema = z
  .object({
    backup: z
      .object({
        path: z.string().min(1),
        report: libraryIntegrityReportSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

const libraryDiagnosticStoredFileSchema = z
  .object({
    present: z.boolean(),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((file, context) => {
    if (!file.present && file.bytes !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bytes"],
        message: "An absent diagnostic file must report zero bytes.",
      });
    }
  })
  .readonly();

const libraryDiagnosticTreeSchema = z
  .object({
    files: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    scanComplete: z.boolean(),
  })
  .strict()
  .readonly();

export const libraryDiagnosticVerificationSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ok"), report: libraryIntegrityReportSchema })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      errorCode: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    })
    .strict(),
]).readonly();

export const libraryDiagnosticBundleSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    application: z
      .object({
        name: z.literal("takio"),
        version: z.string().trim().min(1).max(64),
        implementation: z.literal("rust"),
        platform: z.string().trim().min(1).max(32),
        architecture: z.string().trim().min(1).max(32),
      })
      .strict()
      .readonly(),
    library: z
      .object({
        verification: libraryDiagnosticVerificationSchema,
        storage: z
          .object({
            database: libraryDiagnosticStoredFileSchema,
            jobsDatabase: libraryDiagnosticStoredFileSchema,
            managedItems: libraryDiagnosticTreeSchema,
            covers: libraryDiagnosticTreeSchema,
          })
          .strict()
          .readonly(),
      })
      .strict()
      .readonly(),
    capabilities: z
      .object({
        tui: z.literal(true),
        contentServerLocal: z.literal(true),
        contentServerRemoteTls: z.literal(false),
        metadataCandidateCovers: z.literal(true),
      })
      .strict()
      .readonly(),
    redaction: z
      .object({
        paths: z.literal("omitted"),
        ebookContents: z.literal("omitted"),
        secrets: z.literal("omitted"),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const libraryHealthDiagnosticsRequestSchema = z
  .object({ destinationPath: z.string().trim().min(1) })
  .strict()
  .readonly();

export const libraryHealthDiagnosticsValueSchema = z
  .object({
    diagnostics: z
      .object({
        path: z.string().min(1),
        bytes: z.number().int().positive().max(MAX_LIBRARY_DIAGNOSTIC_BUNDLE_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        generatedAt: z.string().datetime({ offset: true }),
        verificationStatus: z.enum(["ok", "failed"]),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type LibraryHealthErrorCode = (typeof LIBRARY_HEALTH_ERROR_CODES)[number];
export type LibraryIntegrityReport = z.infer<typeof libraryIntegrityReportSchema>;
export type LibraryHealthLocation = z.infer<typeof libraryHealthLocationSchema>;
export type LibraryHealthBackupRequest = z.infer<typeof libraryHealthBackupRequestSchema>;
export type LibraryDiagnosticBundle = z.infer<typeof libraryDiagnosticBundleSchema>;
export type LibraryHealthDiagnosticsRequest = z.infer<typeof libraryHealthDiagnosticsRequestSchema>;
export type LibraryHealthWireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: LibraryHealthErrorCode } };
export type LibraryHealthLocationWireResult = LibraryHealthWireResult<LibraryHealthLocation>;
export type LibraryHealthVerifyWireResult = LibraryHealthWireResult<z.infer<typeof libraryHealthVerifyValueSchema>>;
export type LibraryHealthBackupWireResult = LibraryHealthWireResult<z.infer<typeof libraryHealthBackupValueSchema>>;
export type LibraryHealthDiagnosticsWireResult = LibraryHealthWireResult<z.infer<typeof libraryHealthDiagnosticsValueSchema>>;

export const LIBRARY_STORE_ERROR_CODES = [
  "duplicate-id",
  "invalid-stored-data",
  "storage-unavailable",
  "incompatible-schema",
  "invalid-arguments",
  "invalid-query",
  "cross-device-move",
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
export type LibraryImportMode = (typeof LIBRARY_IMPORT_MODES)[number];
export type ImportLibraryItemRequest = Readonly<{
  sourcePath: string;
  title?: string;
}>;
export type AdoptLibraryItemRequest = Readonly<{ sourcePath: string; title?: string }>;
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
        addedAt: z.string().datetime({ offset: true }),
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

export const METADATA_CANDIDATE_SOURCES = ["filename", "embedded", "online"] as const;
export const METADATA_CANDIDATE_CONFIDENCES = ["low", "medium", "high"] as const;
export const MAX_METADATA_CANDIDATES = 8;
export const MAX_METADATA_CANDIDATE_FIELDS = 13;
export const MAX_METADATA_CANDIDATE_COVER_BYTES = 32 * 1024 * 1024;
export const METADATA_CANDIDATE_COVER_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export const METADATA_CANDIDATE_COVER_EXTENSIONS = [".jpg", ".png", ".gif", ".webp"] as const;
export const METADATA_CANDIDATE_AUDIT_KEY = "takio_metadata_audit";
export const BULK_METADATA_CANDIDATE_SCHEMA_VERSION = 1;
export const MAX_BULK_METADATA_CANDIDATE_ITEMS = 64;
export const MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH = 128;
export const MAX_BULK_METADATA_CANDIDATE_CONCURRENCY = 4;

export const metadataCandidateProvenanceSchema = z
  .object({
    generatedAt: z.string().datetime({ offset: true }),
    // Standalone `metadata candidates filename` output has no item context, so
    // the base schema stays nullable. Item-scoped list responses and apply
    // requests separately require exact, non-null identity with the item.
    itemId: z.string().min(1).max(256).nullable().optional(),
    sourcePath: z.string().min(1).max(4096).optional(),
    pattern: z.string().min(1).max(240).optional(),
    backend: z.enum(["ebook-meta", "fetch-ebook-metadata"]).optional(),
  })
  .strict()
  .readonly();

const metadataCandidateCoverSummaryShape = {
  mediaType: z.enum(METADATA_CANDIDATE_COVER_MEDIA_TYPES),
  extension: z.enum(METADATA_CANDIDATE_COVER_EXTENSIONS),
  bytes: z.number().int().positive().max(MAX_METADATA_CANDIDATE_COVER_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
} as const;

function addCoverMediaTypeIssue(
  cover: Readonly<{ mediaType: string; extension: string }>,
  context: z.RefinementCtx,
) {
  const expectedExtension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  }[cover.mediaType];
  if (cover.extension !== expectedExtension) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["extension"],
      message: "The cover extension must match its media type.",
    });
  }
}

export const metadataCandidateCoverSummarySchema = z
  .object(metadataCandidateCoverSummaryShape)
  .strict()
  .superRefine(addCoverMediaTypeIssue)
  .readonly();

export const metadataCandidateCoverSchema = z
  .object({
    artifactId: z
      .string()
      .regex(/^[0-9a-f]{32}$/, "Cover artifact ids must be opaque path-free tokens."),
    ...metadataCandidateCoverSummaryShape,
  })
  .strict()
  .superRefine(addCoverMediaTypeIssue)
  .readonly();

export const metadataCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(120),
    source: z.enum(METADATA_CANDIDATE_SOURCES),
    confidence: z.enum(METADATA_CANDIDATE_CONFIDENCES),
    patch: libraryMetadataPatchSchema,
    cover: metadataCandidateCoverSchema.optional(),
    provenance: metadataCandidateProvenanceSchema,
  })
  .strict()
  .readonly();

export const listMetadataCandidatesRequestSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    includeOnline: z.boolean(),
  })
  .strict()
  .readonly();

export const metadataCandidateListValueSchema = z
  .object({
    itemId: z.string().min(1).max(256),
    candidates: z.array(metadataCandidateSchema).max(MAX_METADATA_CANDIDATES).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = new Set<string>();
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidateIds.has(candidate.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "id"],
          message: "Candidate ids must be unique within a list.",
        });
      }
      candidateIds.add(candidate.id);
      if (candidate.provenance.itemId !== value.itemId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "provenance", "itemId"],
          message: "Every candidate must be provenance-bound to the listed item.",
        });
      }
    }
  })
  .readonly();

export function metadataCandidateListValueSchemaFor(itemId: string) {
  return metadataCandidateListValueSchema.refine((value) => value.itemId === itemId, {
    message: "Candidate list must answer the requested item.",
  });
}

export const applyMetadataCandidateRequestSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    candidate: metadataCandidateSchema,
    fields: z
      .array(z.string().min(1))
      .max(MAX_METADATA_CANDIDATE_FIELDS)
      .refine((fields) => new Set(fields).size === fields.length, "Fields must be unique.")
      .readonly(),
    cover: z.boolean(),
    provenance: z.string().trim().min(1).max(240),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.candidate.provenance.itemId !== request.itemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidate", "provenance", "itemId"],
        message: "The candidate must be provenance-bound to the requested item.",
      });
    }
    if (request.fields.length === 0 && !request.cover) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields"],
        message: "At least one metadata field or the candidate cover must be selected.",
      });
    }
    if (request.cover && request.candidate.cover === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidate", "cover"],
        message: "A selected cover requires a candidate cover descriptor.",
      });
    }
    for (const [index, field] of request.fields.entries()) {
      if (!Object.hasOwn(request.candidate.patch, field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", index],
          message: "Each selected field must exist in the candidate patch.",
        });
      }
    }
  })
  .readonly();

export const metadataCandidateApplyValueSchema = z
  .object({
    item: libraryItemSchema,
    applied: z
      .object({
        itemId: z.string().min(1).max(256),
        candidateId: z.string().min(1).max(120),
        source: z.enum(METADATA_CANDIDATE_SOURCES),
        provenance: z.string().min(1).max(240),
        fields: z
          .array(z.string().min(1))
          .max(MAX_METADATA_CANDIDATE_FIELDS)
          .refine((fields) => new Set(fields).size === fields.length, "Applied fields must be unique.")
          .readonly(),
        coverApplied: z.boolean(),
        cover: metadataCandidateCoverSummarySchema.optional(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.applied.itemId !== value.item.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied", "itemId"],
        message: "The applied result must describe the returned item.",
      });
    }
    if (value.applied.coverApplied !== (value.applied.cover !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied", "cover"],
        message: "An applied cover summary is required exactly when coverApplied is true.",
      });
    }
    if (value.applied.fields.length === 0 && !value.applied.coverApplied) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied", "fields"],
        message: "An apply result must report metadata fields or an applied cover.",
      });
    }
  })
  .readonly();

export function metadataCandidateApplyValueSchemaFor(itemId: string) {
  return metadataCandidateApplyValueSchema.refine((value) => value.applied.itemId === itemId, {
    message: "Apply result must answer the requested item.",
  });
}

export function metadataCandidateApplyValueSchemaForRequest(
  request: ApplyMetadataCandidateRequest,
) {
  const expectedCover = request.candidate.cover === undefined
    ? undefined
    : {
        mediaType: request.candidate.cover.mediaType,
        extension: request.candidate.cover.extension,
        bytes: request.candidate.cover.bytes,
        sha256: request.candidate.cover.sha256,
      };
  return metadataCandidateApplyValueSchema.superRefine((value, context) => {
    const applied = value.applied;
    const coverMismatch = request.cover && (
      applied.cover === undefined ||
      expectedCover === undefined ||
      applied.cover.mediaType !== expectedCover.mediaType ||
      applied.cover.extension !== expectedCover.extension ||
      applied.cover.bytes !== expectedCover.bytes ||
      applied.cover.sha256 !== expectedCover.sha256
    );
    const mismatch =
      applied.itemId !== request.itemId ||
      value.item.id !== request.itemId ||
      applied.candidateId !== request.candidate.id ||
      applied.source !== request.candidate.source ||
      applied.provenance !== request.provenance ||
      applied.coverApplied !== request.cover ||
      applied.fields.length !== request.fields.length ||
      applied.fields.some((field) => !request.fields.includes(field)) ||
      coverMismatch;
    if (mismatch) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applied"],
        message: "Apply result must exactly answer the requested candidate selection.",
      });
    }
  });
}

const bulkMetadataCandidateItemIdSchema = z.preprocess(
  (itemId) => typeof itemId === "string"
    ? itemId.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    : itemId,
  z
    .string()
    .min(1)
    .max(MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH)
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((itemId) => itemId !== "." && itemId !== "..", {
      message: "Bulk metadata candidate item ids must be safe stored item ids.",
    }),
);
const bulkMetadataCandidateFailureCodeSchema = z.string().trim().min(1).max(120);

export const bulkMetadataCandidateDiscoveryRequestSchema = z
  .object({
    schemaVersion: z.literal(BULK_METADATA_CANDIDATE_SCHEMA_VERSION),
    itemIds: z
      .array(bulkMetadataCandidateItemIdSchema)
      .min(1)
      .max(MAX_BULK_METADATA_CANDIDATE_ITEMS)
      .refine((itemIds) => new Set(itemIds).size === itemIds.length, {
        message: "Bulk metadata candidate item ids must be unique.",
      })
      .readonly(),
    includeOnline: z.boolean(),
    concurrency: z.number().int().min(1).max(MAX_BULK_METADATA_CANDIDATE_CONCURRENCY),
  })
  .strict()
  .readonly();

const readyBulkMetadataCandidateDiscoveryOutcomeSchema = z
  .object({
    status: z.literal("ready"),
    itemId: bulkMetadataCandidateItemIdSchema,
    candidates: z.array(metadataCandidateSchema).min(1).max(MAX_METADATA_CANDIDATES).readonly(),
  })
  .strict();

const bulkMetadataCandidateDiscoveryItemOutcomeSchemas = [
  z.object({ status: z.literal("no-candidates"), itemId: bulkMetadataCandidateItemIdSchema }).strict(),
  z.object({ status: z.literal("missing"), itemId: bulkMetadataCandidateItemIdSchema }).strict(),
  z
    .object({
      status: z.literal("failed"),
      itemId: bulkMetadataCandidateItemIdSchema,
      code: bulkMetadataCandidateFailureCodeSchema,
    })
    .strict(),
  z.object({ status: z.literal("canceled"), itemId: bulkMetadataCandidateItemIdSchema }).strict(),
] as const;

export const bulkMetadataCandidateDiscoveryOutcomeSchema = z
  .discriminatedUnion("status", [
    readyBulkMetadataCandidateDiscoveryOutcomeSchema,
    ...bulkMetadataCandidateDiscoveryItemOutcomeSchemas,
  ])
  .superRefine((outcome, context) => {
    if (outcome.status !== "ready") return;
    for (const [index, candidate] of outcome.candidates.entries()) {
      if (candidate.provenance.itemId !== outcome.itemId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "provenance", "itemId"],
          message: "Every candidate must be provenance-bound to the discovery item.",
        });
      }
    }
  })
  .readonly();

const bulkMetadataCandidateDiscoveryCountsSchema = z
  .object({
    total: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    ready: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    noCandidates: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    missing: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    failed: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    canceled: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
  })
  .strict()
  .readonly();

function addExactOutcomeCountIssues(
  outcomes: readonly Readonly<{ status: string }>[],
  counts: Readonly<Record<string, number>>,
  context: z.RefinementCtx,
): void {
  const expected = {
    total: outcomes.length,
    ready: outcomes.filter(({ status }) => status === "ready").length,
    noCandidates: outcomes.filter(({ status }) => status === "no-candidates").length,
    missing: outcomes.filter(({ status }) => status === "missing").length,
    failed: outcomes.filter(({ status }) => status === "failed").length,
    canceled: outcomes.filter(({ status }) => status === "canceled").length,
  } as const;

  for (const count of Object.keys(expected) as (keyof typeof expected)[]) {
    if (counts[count] !== expected[count]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", count],
        message: `Bulk metadata candidate ${count} must match the reported outcomes.`,
      });
    }
  }
}

export const bulkMetadataCandidateDiscoveryResultSchema = z
  .object({
    schemaVersion: z.literal(BULK_METADATA_CANDIDATE_SCHEMA_VERSION),
    outcomes: z
      .array(bulkMetadataCandidateDiscoveryOutcomeSchema)
      .min(1)
      .max(MAX_BULK_METADATA_CANDIDATE_ITEMS)
      .readonly(),
    counts: bulkMetadataCandidateDiscoveryCountsSchema,
  })
  .strict()
  .superRefine((result, context) => {
    addExactOutcomeCountIssues(result.outcomes, result.counts, context);
  })
  .readonly();

export function bulkMetadataCandidateDiscoveryResultSchemaFor(
  request: BulkMetadataCandidateDiscoveryRequest,
) {
  return bulkMetadataCandidateDiscoveryResultSchema.superRefine((result, context) => {
    for (let index = 0; index < Math.max(request.itemIds.length, result.outcomes.length); index += 1) {
      if (result.outcomes[index]?.itemId !== request.itemIds[index]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index, "itemId"],
          message: "Discovery outcomes must exactly preserve requested item order and identity.",
        });
      }
    }
  });
}

const appliedBulkMetadataCandidateReviewOutcomeSchema = z
  .object({
    status: z.literal("applied"),
    itemId: bulkMetadataCandidateItemIdSchema,
    item: libraryItemSchema,
    candidateId: z.string().trim().min(1).max(120),
    fields: z
      .array(z.string().trim().min(1))
      .max(MAX_METADATA_CANDIDATE_FIELDS)
      .refine((fields) => new Set(fields).size === fields.length, "Fields must be unique.")
      .readonly(),
    coverApplied: z.boolean(),
    cover: metadataCandidateCoverSummarySchema.optional(),
  })
  .strict();

export const bulkMetadataCandidateReviewOutcomeSchema = z
  .discriminatedUnion("status", [
    appliedBulkMetadataCandidateReviewOutcomeSchema,
    z.object({ status: z.literal("skipped"), itemId: bulkMetadataCandidateItemIdSchema }).strict(),
    ...bulkMetadataCandidateDiscoveryItemOutcomeSchemas,
  ])
  .superRefine((outcome, context) => {
    if (outcome.status !== "applied") return;
    if (outcome.item.id !== outcome.itemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["item", "id"],
        message: "The applied review item must match the outcome item id.",
      });
    }
    if (outcome.coverApplied !== (outcome.cover !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cover"],
        message: "An applied cover summary is required exactly when coverApplied is true.",
      });
    }
    if (outcome.fields.length === 0 && !outcome.coverApplied) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields"],
        message: "An applied review outcome must report metadata fields or an applied cover.",
      });
    }
  })
  .readonly();

const bulkMetadataCandidateReviewCountsSchema = z
  .object({
    total: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    applied: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    skipped: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    noCandidates: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    missing: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    failed: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
    canceled: z.number().int().min(0).max(MAX_BULK_METADATA_CANDIDATE_ITEMS),
  })
  .strict()
  .readonly();

export const bulkMetadataCandidateReviewResultSchema = z
  .object({
    schemaVersion: z.literal(BULK_METADATA_CANDIDATE_SCHEMA_VERSION),
    outcomes: z
      .array(bulkMetadataCandidateReviewOutcomeSchema)
      .min(1)
      .max(MAX_BULK_METADATA_CANDIDATE_ITEMS)
      .readonly(),
    counts: bulkMetadataCandidateReviewCountsSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const expected = {
      total: result.outcomes.length,
      applied: result.outcomes.filter(({ status }) => status === "applied").length,
      skipped: result.outcomes.filter(({ status }) => status === "skipped").length,
      noCandidates: result.outcomes.filter(({ status }) => status === "no-candidates").length,
      missing: result.outcomes.filter(({ status }) => status === "missing").length,
      failed: result.outcomes.filter(({ status }) => status === "failed").length,
      canceled: result.outcomes.filter(({ status }) => status === "canceled").length,
    } as const;

    for (const count of Object.keys(expected) as (keyof typeof expected)[]) {
      if (result.counts[count] !== expected[count]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["counts", count],
          message: `Bulk metadata candidate review ${count} must match the reported outcomes.`,
        });
      }
    }
  })
  .readonly();

export function bulkMetadataCandidateReviewResultSchemaFor(itemIds: readonly string[]) {
  return bulkMetadataCandidateReviewResultSchema.superRefine((result, context) => {
    for (let index = 0; index < Math.max(itemIds.length, result.outcomes.length); index += 1) {
      if (result.outcomes[index]?.itemId !== itemIds[index]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index, "itemId"],
          message: "Review outcomes must exactly preserve requested item order and identity.",
        });
      }
    }
  });
}

export type MetadataCandidate = z.infer<typeof metadataCandidateSchema>;
export type ListMetadataCandidatesRequest = z.infer<typeof listMetadataCandidatesRequestSchema>;
export type ApplyMetadataCandidateRequest = z.infer<typeof applyMetadataCandidateRequestSchema>;
export type BulkMetadataCandidateDiscoveryRequest = z.infer<
  typeof bulkMetadataCandidateDiscoveryRequestSchema
>;
export type BulkMetadataCandidateDiscoveryOutcome = z.infer<
  typeof bulkMetadataCandidateDiscoveryOutcomeSchema
>;
export type BulkMetadataCandidateDiscoveryResult = z.infer<
  typeof bulkMetadataCandidateDiscoveryResultSchema
>;
export type BulkMetadataCandidateReviewOutcome = z.infer<
  typeof bulkMetadataCandidateReviewOutcomeSchema
>;
export type BulkMetadataCandidateReviewResult = z.infer<
  typeof bulkMetadataCandidateReviewResultSchema
>;
export type MetadataCandidateListWireResult = LibraryStoreResult<
  z.infer<typeof metadataCandidateListValueSchema>
>;
export type MetadataCandidateApplyWireResult = LibraryStoreResult<
  z.infer<typeof metadataCandidateApplyValueSchema>
>;

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
export type AdoptLibraryItemResult = LibraryStoreResult<{
  readonly item: LibraryItem;
  readonly sourceCleanupPending: boolean;
}>;
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

export type VirtualLibraryStore = SavedLibraryViewStore;

export interface LibraryFormatReplacementStore {
  replaceFormat(request: ReplaceLibraryFormatRequest): Promise<ReplaceLibraryFormatResult>;
}

export interface LibraryBatchImportStore {
  importMany(request: ImportLibraryItemsRequest): Promise<ImportLibraryItemsResult>;
}

export interface LibraryAdoptionStore {
  adopt(request: AdoptLibraryItemRequest): Promise<AdoptLibraryItemResult>;
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
