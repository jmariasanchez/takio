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
  const applied = {
    itemId: "book-1",
    candidateId: "filename:1",
    source: "filename",
    provenance: "desktop-candidate-review:filename",
    fields: ["title"],
    coverApplied: false,
  } as const;

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
        cover: false,
        provenance: "desktop-candidate-review:filename",
      },
      returns({ ok: true, value: { item, applied } }),
    )).toEqual({ ok: true, value: { item, applied } });
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
        cover: false,
        provenance: "desktop-candidate-review:filename",
      },
      returns({ ok: true, value: { item } }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });
  });

  test("rejects list responses that answer a different item or carry foreign candidates", async () => {
    // The response answers another item entirely.
    expect(await listMetadataCandidates(
      { itemId: "book-1", includeOnline: false },
      returns({ ok: true, value: { itemId: "book-2", candidates: [] } }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });

    expect(await listMetadataCandidates(
      { itemId: "book-1", includeOnline: false },
      returns({ ok: true, value: { itemId: "book-1", candidates: [candidate, { ...candidate, patch: { title: "Other" } }] } }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });

    // The response answers this item but smuggles a foreign candidate.
    expect(await listMetadataCandidates(
      { itemId: "book-1", includeOnline: false },
      returns({
        ok: true,
        value: {
          itemId: "book-1",
          candidates: [
            { ...candidate, provenance: { ...candidate.provenance, itemId: "book-9" } },
          ],
        },
      }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });
  });

  test("refuses to send a candidate bound to a different item", async () => {
    let invoked = false;
    expect(await applyMetadataCandidate(
      {
        itemId: "book-2",
        candidate,
        fields: ["title"],
        cover: false,
        provenance: "desktop-candidate-review:filename",
      },
      async () => {
        invoked = true;
        return null as never;
      },
    )).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(invoked).toBe(false);
  });

  test("rejects apply responses that describe another item", async () => {
    expect(await applyMetadataCandidate(
      {
        itemId: "book-1",
        candidate,
        fields: ["title"],
        cover: false,
        provenance: "desktop-candidate-review:filename",
      },
      returns({ ok: true, value: { item, applied: { ...applied, itemId: "book-9" } } }),
    )).toEqual({ ok: false, error: { code: "protocol-error" } });
  });

  test("rejects apply responses that do not exactly match the request", async () => {
    const request = {
      itemId: "book-1",
      candidate,
      fields: ["title"],
      cover: false,
      provenance: "desktop-candidate-review:filename",
    } as const;
    for (const mismatch of [
      { ...applied, candidateId: "filename:2" },
      { ...applied, source: "embedded" },
      { ...applied, provenance: "other" },
      { ...applied, fields: ["publisher"] },
      { ...applied, coverApplied: true, cover: { mediaType: "image/jpeg", extension: ".jpg", bytes: 6, sha256: "a".repeat(64) } },
    ]) {
      expect(await applyMetadataCandidate(request, returns({ ok: true, value: { item, applied: mismatch } })))
        .toEqual({ ok: false, error: { code: "protocol-error" } });
    }
  });

  test("requires exact coverApplied and cover summary accounting", async () => {
    const cover = {
      mediaType: "image/jpeg",
      extension: ".jpg",
      bytes: 6,
      sha256: "a".repeat(64),
    } as const;
    const request = {
      itemId: "book-1",
      candidate: {
        ...candidate,
        cover: { artifactId: "0123456789abcdef0123456789abcdef", ...cover },
      },
      fields: [],
      cover: true,
      provenance: "desktop-candidate-review:filename",
    } as const;
    expect(await applyMetadataCandidate(
      request,
      returns({ ok: true, value: { item, applied: { ...applied, fields: [], coverApplied: true, cover } } }),
    )).toEqual({ ok: true, value: { item, applied: { ...applied, fields: [], coverApplied: true, cover } } });
    for (const malformed of [
      { ...applied, fields: [], coverApplied: true },
      { ...applied, coverApplied: false, cover },
      { ...applied, fields: [], coverApplied: false },
      { ...applied, fields: [], coverApplied: true, cover: { ...cover, extension: ".png" } },
      { ...applied, fields: [], coverApplied: true, cover: { ...cover, artifactId: request.candidate.cover.artifactId } },
    ]) {
      expect(await applyMetadataCandidate(
        request,
        returns({ ok: true, value: { item, applied: malformed } }),
      )).toEqual({ ok: false, error: { code: "protocol-error" } });
    }
  });
});
