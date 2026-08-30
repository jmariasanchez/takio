import { describe, expect, test } from "bun:test";

import { buildEngineArguments } from "./engine";

const candidate = {
  schemaVersion: 1,
  id: "embedded:1",
  source: "embedded",
  confidence: "high",
  patch: { title: "Candidate title", publisher: "Candidate publisher" },
  provenance: {
    generatedAt: "1970-01-01T00:00:00.000Z",
    itemId: "book-1",
    sourcePath: "/Books/book.epub",
    backend: "ebook-meta",
  },
} as const;

describe("metadata candidate engine arguments", () => {
  test("maps list requests to a fixed allowlisted argument array", async () => {
    expect(await buildEngineArguments("metadata_candidates_list", {
      request: { itemId: "book-1", includeOnline: true },
    })).toEqual([
      "metadata", "candidates", "item", "--id", "book-1", "--include-online",
    ]);
    expect(await buildEngineArguments("metadata_candidates_list", {
      request: { itemId: "book-1", includeOnline: true, executable: "sh" },
    })).toBeNull();
  });

  test("serializes only explicitly selected fields into one bounded literal argument", async () => {
    const args = await buildEngineArguments("metadata_candidates_apply", {
      request: {
        itemId: "book-1",
        candidate,
        fields: ["title"],
        provenance: "desktop-candidate-review:embedded",
      },
    });
    expect(args?.slice(0, 5)).toEqual([
      "metadata", "candidates", "apply", "--id", "book-1",
    ]);
    const candidateJsonIndex = args?.indexOf("--candidate-json") ?? -1;
    const serialized = JSON.parse(args?.[candidateJsonIndex + 1] ?? "null");
    expect(serialized.patch).toEqual({ title: "Candidate title" });
    expect(serialized.patch).not.toHaveProperty("publisher");
    expect(args?.slice(-2)).toEqual([
      "--provenance", "desktop-candidate-review:embedded",
    ]);
  });

  test("rejects empty, unknown, and oversized selection requests", async () => {
    expect(await buildEngineArguments("metadata_candidates_apply", {
      request: {
        itemId: "book-1",
        candidate,
        fields: [],
        provenance: "desktop-candidate-review:embedded",
      },
    })).toBeNull();
    expect(await buildEngineArguments("metadata_candidates_apply", {
      request: {
        itemId: "book-1",
        candidate,
        fields: ["description"],
        provenance: "desktop-candidate-review:embedded",
      },
    })).toBeNull();
    expect(await buildEngineArguments("metadata_candidates_apply", {
      request: {
        itemId: "book-1",
        candidate: { ...candidate, patch: { description: "x".repeat(20_000) } },
        fields: ["description"],
        provenance: "desktop-candidate-review:embedded",
      },
    })).toBeNull();
  });
});
