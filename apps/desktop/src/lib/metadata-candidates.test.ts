import { describe, expect, test } from "bun:test";

import {
  applyMetadataCandidate,
  listMetadataCandidates,
  type LibraryInvoker,
} from "./library";

function returns(value: unknown): LibraryInvoker {
  return async <T>() => value as T;
}

const candidate = {
  schemaVersion: 1,
  id: "filename:1",
  source: "filename",
  confidence: "medium",
  patch: { title: "Candidate title" },
  provenance: {
    generatedAt: "1970-01-01T00:00:00.000Z",
    itemId: "book-1",
    sourcePath: "/Books/book.epub",
    pattern: "(?<title>.+)",
  },
} as const;

const item = {
  id: "book-1",
  title: "Candidate title",
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

describe("metadata candidate renderer decoder", () => {
  test("accepts strict list and apply envelopes", async () => {
    expect(await listMetadataCandidates(
      { itemId: "book-1", includeOnline: false },
      returns({ ok: true, value: { itemId: "book-1", candidates: [candidate] } }),
    )).toEqual({ ok: true, value: { itemId: "book-1", candidates: [candidate] } });

    expect(await applyMetadataCandidate(
      {
        itemId: "book-1",
        candidate,
        fields: ["title"],
        provenance: "desktop-candidate-review:filename",
      },
      returns({
        ok: true,
        value: {
          item,
          applied: {
            candidateId: "filename:1",
            source: "filename",
            provenance: "desktop-candidate-review:filename",
          },
        },
      }),
    )).toEqual({
      ok: true,
      value: {
        item,
        applied: {
          candidateId: "filename:1",
          source: "filename",
          provenance: "desktop-candidate-review:filename",
        },
      },
    });
  });

  test("converts malformed and over-broad envelopes to protocol errors", async () => {
    expect(await listMetadataCandidates(
      { itemId: "book-1", includeOnline: false },
      returns({
        ok: true,
        value: { itemId: "book-1", candidates: [candidate], filesystemPath: "/private/db" },
      }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });

    expect(await applyMetadataCandidate(
      {
        itemId: "book-1",
        candidate,
        fields: ["title"],
        provenance: "desktop-candidate-review:filename",
      },
      returns({ ok: true, value: { item } }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });
  });
});
