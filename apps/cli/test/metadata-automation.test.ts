import { describe, expect, it } from "bun:test";

import {
  candidateFromPatch,
  parseFilenameMetadataCandidates,
  parseMetadataCandidateJson,
} from "../src/metadata-automation.js";

describe("metadata automation candidates", () => {
  it("parses common filename patterns into deterministic bounded candidates", () => {
    const candidates = parseFilenameMetadataCandidates({
      sourcePath: "/books/Ann Author - Saga 02 - The_Title.epub",
      itemId: "book-1",
      generatedAt: "1970-01-01T00:00:00.000Z",
    });

    expect(candidates[0]).toMatchObject({
      schemaVersion: 1,
      id: "filename:1",
      source: "filename",
      patch: {
        title: "The Title",
        author: "Ann Author",
        authors: [{ name: "Ann Author" }],
        series: "Saga",
        seriesIndex: 2,
      },
      provenance: {
        generatedAt: "1970-01-01T00:00:00.000Z",
        itemId: "book-1",
        sourcePath: "/books/Ann Author - Saga 02 - The_Title.epub",
      },
    });
    expect(candidates.length).toBeLessThanOrEqual(8);
  });

  it("accepts explicit candidates and rejects unsupported schema versions", () => {
    const candidate = candidateFromPatch({
      id: "manual:1",
      source: "manual",
      confidence: "high",
      patch: { title: "Reviewed Title" },
      provenance: { generatedAt: "1970-01-01T00:00:00.000Z" },
    });

    expect(parseMetadataCandidateJson(JSON.stringify(candidate))).toEqual(candidate);
    expect(parseMetadataCandidateJson(JSON.stringify({ ...candidate, schemaVersion: 2 }))).toBeNull();
  });
});
