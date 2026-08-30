import { describe, expect, it } from "bun:test";

import {
  applyMetadataCandidateRequestSchema,
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
