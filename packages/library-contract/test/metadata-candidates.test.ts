import { describe, expect, it } from "bun:test";

import {
  BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
  MAX_BULK_METADATA_CANDIDATE_CONCURRENCY,
  MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH,
  MAX_BULK_METADATA_CANDIDATE_ITEMS,
  applyMetadataCandidateRequestSchema,
  bulkMetadataCandidateDiscoveryRequestSchema,
  bulkMetadataCandidateDiscoveryResultSchemaFor,
  bulkMetadataCandidateReviewResultSchemaFor,
  metadataCandidateApplyValueSchema,
  metadataCandidateApplyValueSchemaFor,
  metadataCandidateListValueSchema,
  metadataCandidateListValueSchemaFor,
  metadataCandidateSchema,
} from "../src/index.js";

const candidate = {
  schemaVersion: 1,
  id: "embedded:1",
  source: "embedded",
  confidence: "high",
  patch: { title: "A better title", publisher: "Example Press" },
  provenance: {
    generatedAt: "1970-01-01T00:00:00.000Z",
    itemId: "book-1",
    sourcePath: "/Books/book.epub",
    backend: "ebook-meta",
  },
} as const;

const item = {
  id: "book-1",
  title: "A better title",
  sourcePath: "/Books/book.epub",
  format: "epub",
  addedAt: "2026-08-30T20:00:00.000Z",
  formats: [{
    sourcePath: "/Books/book.epub",
    format: "epub",
    addedAt: "2026-08-30T20:00:00.000Z",
    provenance: "managed",
  }],
  tags: [],
} as const;

describe("metadata candidate contract", () => {
  it("accepts bounded strict candidate lists and rejects extra data", () => {
    expect(metadataCandidateListValueSchema.parse({ itemId: "book-1", candidates: [candidate] }))
      .toEqual({ itemId: "book-1", candidates: [candidate] });
    expect(metadataCandidateSchema.safeParse({ ...candidate, coverPath: "/tmp/cover.jpg" }).success)
      .toBe(false);
    expect(metadataCandidateListValueSchema.safeParse({
      itemId: "book-1",
      candidates: Array.from({ length: 9 }, (_, index) => ({ ...candidate, id: `embedded:${index}` })),
    }).success).toBe(false);
  });

  it("requires explicit unique fields present in the candidate patch", () => {
    expect(applyMetadataCandidateRequestSchema.parse({
      itemId: "book-1",
      candidate,
      fields: ["title"],
      provenance: "desktop-candidate-review:embedded",
    }).fields).toEqual(["title"]);
    expect(applyMetadataCandidateRequestSchema.safeParse({
      itemId: "book-1",
      candidate,
      fields: [],
      provenance: "desktop-candidate-review:embedded",
    }).success).toBe(false);
    expect(applyMetadataCandidateRequestSchema.safeParse({
      itemId: "book-1",
      candidate,
      fields: ["description"],
      provenance: "desktop-candidate-review:embedded",
    }).success).toBe(false);
  });

  it("decodes the apply value as a strict envelope payload bound to the item", () => {
    const applied = {
      itemId: "book-1",
      candidateId: "embedded:1",
      source: "embedded",
      provenance: "desktop-candidate-review:embedded",
      fields: ["title"],
    } as const;
    expect(metadataCandidateApplyValueSchema.safeParse({ item, applied }).success).toBe(true);
    expect(metadataCandidateApplyValueSchema.safeParse({
      item,
      applied: { ...applied, silentlyOverwrote: true },
    }).success).toBe(false);
    // The applied record must describe the returned item.
    expect(metadataCandidateApplyValueSchema.safeParse({
      item,
      applied: { ...applied, itemId: "book-2" },
    }).success).toBe(false);
    // And it must answer the item the caller actually requested.
    expect(metadataCandidateApplyValueSchemaFor("book-1").safeParse({ item, applied }).success)
      .toBe(true);
    expect(metadataCandidateApplyValueSchemaFor("book-2").safeParse({ item, applied }).success)
      .toBe(false);

    const nativeItem = {
      ...item,
      addedAt: "2026-08-30T20:00:00+00:00",
      formats: [{ ...item.formats[0], addedAt: "2026-08-30T16:00:00-04:00" }],
    };
    expect(metadataCandidateApplyValueSchemaFor("book-1").safeParse({
      item: nativeItem,
      applied,
    }).success).toBe(true);
  });

  it("binds every listed candidate to the requested item", () => {
    const foreign = {
      ...candidate,
      provenance: { ...candidate.provenance, itemId: "book-9" },
    };
    expect(metadataCandidateListValueSchema.safeParse({
      itemId: "book-1",
      candidates: [foreign],
    }).success).toBe(false);
    // Item-scoped responses require non-null identity even though the base
    // candidate schema still allows standalone filename candidates.
    expect(metadataCandidateListValueSchema.safeParse({
      itemId: "book-1",
      candidates: [{ ...candidate, provenance: { generatedAt: candidate.provenance.generatedAt } }],
    }).success).toBe(false);
    expect(metadataCandidateListValueSchemaFor("book-2").safeParse({
      itemId: "book-1",
      candidates: [candidate],
    }).success).toBe(false);
  });

  it("keeps standalone filename candidates without an item valid", () => {
    expect(metadataCandidateSchema.safeParse({
      ...candidate,
      source: "filename",
      provenance: {
        generatedAt: "1970-01-01T00:00:00.000Z",
        itemId: null,
        sourcePath: "/Books/book.epub",
        pattern: "(?<title>.+)",
      },
    }).success).toBe(true);
    expect(metadataCandidateSchema.safeParse({
      ...candidate,
      source: "filename",
      provenance: { generatedAt: "1970-01-01T00:00:00.000Z" },
    }).success).toBe(true);
    expect(metadataCandidateSchema.safeParse({
      ...candidate,
      provenance: { ...candidate.provenance, generatedAt: "1970-01-01T01:00:00+01:00" },
    }).success).toBe(true);
  });

  it("refuses to apply a candidate generated for another item", () => {
    expect(applyMetadataCandidateRequestSchema.safeParse({
      itemId: "book-2",
      candidate,
      fields: ["title"],
      provenance: "desktop-candidate-review:embedded",
    }).success).toBe(false);
    expect(applyMetadataCandidateRequestSchema.safeParse({
      itemId: "book-1",
      candidate: { ...candidate, provenance: { generatedAt: candidate.provenance.generatedAt } },
      fields: ["title"],
      provenance: "desktop-candidate-review:embedded",
    }).success).toBe(false);
  });
});

describe("bulk metadata candidate contract", () => {
  const request = {
    schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
    itemIds: ["book-1", "book-2", "book-3", "book-4", "book-5"],
    includeOnline: true,
    concurrency: MAX_BULK_METADATA_CANDIDATE_CONCURRENCY,
  } as const;

  const discoveryResult = {
    schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
    outcomes: [
      { status: "ready", itemId: "book-1", candidates: [candidate] },
      { status: "no-candidates", itemId: "book-2" },
      { status: "missing", itemId: "book-3" },
      { status: "failed", itemId: "book-4", code: "online-unavailable" },
      { status: "canceled", itemId: "book-5" },
    ],
    counts: { total: 5, ready: 1, noCandidates: 1, missing: 1, failed: 1, canceled: 1 },
  } as const;

  it("accepts bounded requests and rejects duplicates and bounds violations", () => {
    expect(bulkMetadataCandidateDiscoveryRequestSchema.parse(request)).toEqual(request);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: ["book-1", "book-1"],
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: [],
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: Array.from({ length: MAX_BULK_METADATA_CANDIDATE_ITEMS + 1 }, (_, index) =>
        `book-${index}`),
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      concurrency: MAX_BULK_METADATA_CANDIDATE_CONCURRENCY + 1,
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: ["x".repeat(MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH + 1)],
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: ["😀"],
    }).success).toBe(false);
    for (const itemId of [".", ".."] as const) {
      expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
        ...request,
        itemIds: [itemId],
      }).success).toBe(false);
    }
  });

  it("keeps every schema-valid compact request within the structured transport cap", () => {
    const itemIds = Array.from({ length: MAX_BULK_METADATA_CANDIDATE_ITEMS }, (_, index) =>
      `${index.toString().padStart(2, "0")}${"x".repeat(MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH - 2)}`
    );
    const maximumRequest = {
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      itemIds,
      includeOnline: true,
      concurrency: MAX_BULK_METADATA_CANDIDATE_CONCURRENCY,
    } as const;

    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse(maximumRequest).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(maximumRequest)).byteLength).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it("matches the safe ASCII item id domain", () => {
    const boundary = "x".repeat(MAX_BULK_METADATA_CANDIDATE_ITEM_ID_LENGTH);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: [boundary],
    }).success).toBe(true);
    expect(bulkMetadataCandidateDiscoveryRequestSchema.safeParse({
      ...request,
      itemIds: [`${boundary}x`],
    }).success).toBe(false);
  });

  it("accepts all discovery outcomes with exact ordered identity and counts", () => {
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor(request).safeParse(discoveryResult).success)
      .toBe(true);
  });

  it("rejects cross-item candidates, omissions, reordering, and count mismatches", () => {
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor(request).safeParse({
      ...discoveryResult,
      outcomes: [{
        status: "ready",
        itemId: "book-1",
        candidates: [{
          ...candidate,
          provenance: { ...candidate.provenance, itemId: "book-2" },
        }],
      }, ...discoveryResult.outcomes.slice(1)],
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor(request).safeParse({
      ...discoveryResult,
      outcomes: discoveryResult.outcomes.slice(0, -1),
      counts: { ...discoveryResult.counts, total: 4, canceled: 0 },
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor(request).safeParse({
      ...discoveryResult,
      outcomes: [discoveryResult.outcomes[1], discoveryResult.outcomes[0],
        ...discoveryResult.outcomes.slice(2)],
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor(request).safeParse({
      ...discoveryResult,
      counts: { ...discoveryResult.counts, ready: 2 },
    }).success).toBe(false);
  });

  it("enforces candidate, failure-code, and applied-field bounds", () => {
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor({
      ...request,
      itemIds: ["book-1"],
    }).safeParse({
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      outcomes: [{ status: "ready", itemId: "book-1", candidates: [] }],
      counts: { total: 1, ready: 1, noCandidates: 0, missing: 0, failed: 0, canceled: 0 },
    }).success).toBe(false);
    expect(bulkMetadataCandidateDiscoveryResultSchemaFor({
      ...request,
      itemIds: ["book-1"],
    }).safeParse({
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      outcomes: [{ status: "failed", itemId: "book-1", code: "x".repeat(121) }],
      counts: { total: 1, ready: 0, noCandidates: 0, missing: 0, failed: 1, canceled: 0 },
    }).success).toBe(false);
  });

  it("accepts exact ordered final review outcomes and rejects invalid reconciliation", () => {
    const itemIds = request.itemIds;
    const reviewResult = {
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      outcomes: [
        { status: "applied", itemId: "book-1", item, candidateId: candidate.id, fields: ["title"] },
        { status: "skipped", itemId: "book-2" },
        { status: "no-candidates", itemId: "book-3" },
        { status: "failed", itemId: "book-4", code: "write-failed" },
        { status: "canceled", itemId: "book-5" },
      ],
      counts: {
        total: 5,
        applied: 1,
        skipped: 1,
        noCandidates: 1,
        missing: 0,
        failed: 1,
        canceled: 1,
      },
    } as const;

    expect(bulkMetadataCandidateReviewResultSchemaFor(itemIds).safeParse(reviewResult).success)
      .toBe(true);
    expect(bulkMetadataCandidateReviewResultSchemaFor(itemIds).safeParse({
      ...reviewResult,
      outcomes: reviewResult.outcomes.slice(1),
      counts: { ...reviewResult.counts, total: 4, applied: 0 },
    }).success).toBe(false);
    expect(bulkMetadataCandidateReviewResultSchemaFor(itemIds).safeParse({
      ...reviewResult,
      counts: { ...reviewResult.counts, skipped: 2 },
    }).success).toBe(false);
    expect(bulkMetadataCandidateReviewResultSchemaFor(["book-1"]).safeParse({
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      outcomes: [{
        status: "applied",
        itemId: "book-1",
        item: { ...item, id: "book-2" },
        candidateId: candidate.id,
        fields: Array.from({ length: 14 }, (_, index) => `field-${index}`),
      }],
      counts: {
        total: 1,
        applied: 1,
        skipped: 0,
        noCandidates: 0,
        missing: 0,
        failed: 0,
        canceled: 0,
      },
    }).success).toBe(false);
  });
});
