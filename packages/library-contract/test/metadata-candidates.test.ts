import { describe, expect, it } from "bun:test";

import {
  applyMetadataCandidateRequestSchema,
  metadataCandidateApplyValueSchema,
  metadataCandidateListValueSchema,
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

  it("decodes the apply value as a strict envelope payload", () => {
    expect(metadataCandidateApplyValueSchema.safeParse({
      item,
      applied: {
        candidateId: "embedded:1",
        source: "embedded",
        provenance: "desktop-candidate-review:embedded",
      },
    }).success).toBe(true);
    expect(metadataCandidateApplyValueSchema.safeParse({
      item,
      applied: {
        candidateId: "embedded:1",
        source: "embedded",
        provenance: "desktop-candidate-review:embedded",
        silentlyOverwrote: true,
      },
    }).success).toBe(false);
  });
});
