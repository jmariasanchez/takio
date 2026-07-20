import { expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import { libraryMetadataPatchSchema } from "@takio/library-contract";

import {
  draftFor,
  parseMetadataDraft,
  type MetadataDraft,
} from "./metadata-draft";

const item: LibraryItem = {
  id: "item-1",
  title: "Kindred",
  sourcePath: "/Books/Kindred.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [
    {
      sourcePath: "/Books/Kindred.epub",
      format: "epub",
      addedAt: "2026-07-18T12:00:00.000Z",
      provenance: "managed",
    },
  ],
  author: "Octavia E. Butler",
  authors: [
    { name: "Octavia E. Butler", sortName: "Butler, Octavia E." },
    { name: "Contributor" },
  ],
  series: "Patternist",
  seriesIndex: 4.5,
  publisher: "Doubleday",
  languages: ["en-US", "fr"],
  identifiers: { isbn: "978-0-385-15059-0", asin: "B00TEST" },
  publishedDate: "1979-06",
  rating: 8.5,
  description: "A novel",
  tags: ["Classic", "Science Fiction"],
};

function draftWith(overrides: Partial<MetadataDraft>): MetadataDraft {
  return { ...draftFor(item), ...overrides };
}

test("creates an unchanged draft without losing ordered rich metadata", () => {
  expect(draftFor(item)).toEqual({
    title: { state: "unchanged", value: "Kindred" },
    authors: {
      state: "unchanged",
      value: [
        { name: "Octavia E. Butler", sortName: "Butler, Octavia E." },
        { name: "Contributor", sortName: "" },
      ],
    },
    series: { state: "unchanged", value: "Patternist" },
    seriesIndex: { state: "unchanged", value: "4.5" },
    publisher: { state: "unchanged", value: "Doubleday" },
    languages: { state: "unchanged", value: ["en-US", "fr"] },
    identifiers: {
      state: "unchanged",
      value: [
        { type: "isbn", value: "978-0-385-15059-0" },
        { type: "asin", value: "B00TEST" },
      ],
    },
    publishedDate: { state: "unchanged", value: "1979-06" },
    rating: { state: "unchanged", value: "8.5" },
    description: { state: "unchanged", value: "A novel" },
    tags: { state: "unchanged", value: ["Classic", "Science Fiction"] },
  });
});

test("uses the legacy author as the editable contributor when structured authors are absent", () => {
  const legacyItem = { ...item, authors: undefined };

  expect(draftFor(legacyItem).authors).toEqual({
    state: "unchanged",
    value: [{ name: "Octavia E. Butler", sortName: "" }],
  });
});

test("parses concrete values, preserves list order, and trims contract text", () => {
  const result = parseMetadataDraft(
    draftWith({
      title: { state: "concrete", value: "  Parable of the Sower  " },
      authors: {
        state: "concrete",
        value: [
          { name: "  Octavia E. Butler ", sortName: " Butler, Octavia E. " },
          { name: "  Second Author  ", sortName: "  " },
        ],
      },
      series: { state: "concrete", value: "  Earthseed  " },
      seriesIndex: { state: "concrete", value: "2.5" },
      publisher: { state: "concrete", value: "  Four Walls Eight Windows  " },
      languages: { state: "concrete", value: [" en-US ", " fr "] },
      identifiers: {
        state: "concrete",
        value: [
          { type: " isbn ", value: " 9780446675505 " },
          { type: " asin ", value: " B00TEST " },
        ],
      },
      publishedDate: { state: "concrete", value: "1993-10" },
      rating: { state: "concrete", value: "9.25" },
      description: { state: "concrete", value: "  A novel.  " },
      tags: {
        state: "concrete",
        value: [" Classic ", " Speculative Fiction "],
      },
    }),
  );

  expect(result).toEqual({
    ok: true,
    patch: {
      title: "Parable of the Sower",
      author: "Octavia E. Butler",
      authors: [
        { name: "Octavia E. Butler", sortName: "Butler, Octavia E." },
        { name: "Second Author" },
      ],
      series: "Earthseed",
      seriesIndex: 2.5,
      publisher: "Four Walls Eight Windows",
      languages: ["en-US", "fr"],
      identifiers: { isbn: "9780446675505", asin: "B00TEST" },
      publishedDate: "1993-10",
      rating: 9.25,
      description: "A novel.",
      tags: ["Classic", "Speculative Fiction"],
    },
  });
  if (result.ok) expect(libraryMetadataPatchSchema.parse(result.patch)).toEqual(result.patch);
});

test("keeps unchanged fields omitted and represents explicit clears with null", () => {
  const unchanged = parseMetadataDraft(draftFor(item));
  expect(unchanged).toEqual({
    ok: true,
    patch: { tags: ["Classic", "Science Fiction"] },
  });

  const cleared = parseMetadataDraft(
    draftWith({
      authors: { state: "clear", value: [] },
      series: { state: "clear", value: "" },
      seriesIndex: { state: "clear", value: "" },
      publisher: { state: "clear", value: "" },
      languages: { state: "clear", value: [] },
      identifiers: { state: "clear", value: [] },
      publishedDate: { state: "clear", value: "" },
      rating: { state: "clear", value: "" },
      description: { state: "clear", value: "" },
      tags: { state: "concrete", value: [] },
    }),
  );
  expect(cleared).toEqual({
    ok: true,
    patch: {
      author: null,
      authors: null,
      series: null,
      seriesIndex: null,
      publisher: null,
      languages: null,
      identifiers: null,
      publishedDate: null,
      rating: null,
      description: null,
      tags: [],
    },
  });
});

test("accepts all supported published-date partials and rejects impossible dates", () => {
  for (const value of ["1979", "1979-06", "2000-02-29"]) {
    const result = parseMetadataDraft(
      draftWith({ publishedDate: { state: "concrete", value } }),
    );
    expect(result.ok && result.patch.publishedDate).toBe(value);
  }

  for (const value of [" 1979", "1979-13", "1979-02-29", "2000-04-31", "1979-6"]) {
    const result = parseMetadataDraft(
      draftWith({ publishedDate: { state: "concrete", value } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.publishedDate).toBeDefined();
  }
});

test("rejects invalid numeric forms without coercing them", () => {
  for (const value of ["", " ", "0x10", "1 value", "NaN", "Infinity", "1e9999"]) {
    const result = parseMetadataDraft(
      draftWith({ seriesIndex: { state: "concrete", value } }),
    );
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        seriesIndex: "Enter a finite decimal number or choose Clear.",
      },
      summary: "Correct 1 metadata field before saving.",
    });
  }
});

test("accepts finite fractional indices and enforces the contract rating range", () => {
  for (const value of ["-1", ".5", "1.", "2.5", "1e2"]) {
    const result = parseMetadataDraft(
      draftWith({ seriesIndex: { state: "concrete", value } }),
    );
    expect(result.ok).toBe(true);
  }

  for (const value of ["-0.1", "10.1"]) {
    const result = parseMetadataDraft(
      draftWith({ rating: { state: "concrete", value } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.rating).toBeDefined();
  }
  for (const value of ["0", "8.5", "10"]) {
    const result = parseMetadataDraft(
      draftWith({ rating: { state: "concrete", value } }),
    );
    expect(result.ok && result.patch.rating).toBe(Number(value));
  }
});

test("returns row-addressable errors and a form summary without dropping invalid rows", () => {
  const result = parseMetadataDraft(
    draftWith({
      authors: {
        state: "concrete",
        value: [
          { name: "", sortName: "" },
          { name: "Valid Author", sortName: "" },
        ],
      },
      languages: { state: "concrete", value: ["English", "fr"] },
      identifiers: {
        state: "concrete",
        value: [
          { type: "isbn", value: "9780446675505" },
          { type: " isbn ", value: "another" },
          { type: "", value: "" },
        ],
      },
      tags: { state: "concrete", value: ["Classic", " classic "] },
    }),
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.fieldErrors).toEqual({
      "identifiers.1.type": "Identifier type “isbn” is already present.",
      "identifiers.2.type": "Enter an identifier type.",
      "identifiers.2.value": "Enter an identifier value.",
      "authors.0.name": "Enter an author name.",
      "languages.0": "Enter a valid language tag, such as en or en-US.",
      "tags.1": "Tags must be unique ignoring case.",
    });
    expect(result.summary).toBe("Correct 6 metadata fields before saving.");
  }
});

test("reports empty concrete values instead of treating them as unchanged or clear", () => {
  const result = parseMetadataDraft(
    draftWith({
      title: { state: "concrete", value: " " },
      authors: { state: "concrete", value: [] },
      series: { state: "concrete", value: " " },
      publisher: { state: "concrete", value: " " },
      languages: { state: "concrete", value: [] },
      description: { state: "concrete", value: " " },
      tags: { state: "concrete", value: [" "] },
    }),
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.fieldErrors).toEqual({
      title: "Enter a title.",
      authors: "Add at least one author or choose Clear.",
      series: "Enter a value or choose Clear.",
      publisher: "Enter a value or choose Clear.",
      languages: "Add at least one language or choose Clear.",
      description: "Enter a value or choose Clear.",
      "tags.0": "Enter a tag.",
    });
    expect(result.summary).toBe("Correct 7 metadata fields before saving.");
  }
});
