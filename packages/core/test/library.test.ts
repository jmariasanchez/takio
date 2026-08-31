import { describe, expect, it } from "bun:test";

import {
  InMemoryLibraryRepository,
  BOOK_FORMAT_PROVENANCES,
  bookAuthorSchema,
  bookCustomMetadataSchema,
  bookFormatSchema,
  bookFormatsSchema,
  bookIdentifiersSchema,
  languageTagSchema,
  libraryItemSchema,
  normalizeTags,
  publishedDateSchema,
  type BookAuthor,
  type BookCustomMetadata,
  type BookFormat,
  type BookIdentifiers,
  type LibraryItem,
} from "../src/index.js";

const v1Item = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
} as const;
const epubFormat: BookFormat = {
  sourcePath: v1Item.sourcePath,
  format: "epub",
  addedAt: v1Item.addedAt,
  provenance: "managed",
};
const pdfFormat: BookFormat = {
  sourcePath: "library/left-hand.pdf",
  format: "pdf",
  addedAt: "2026-07-19T12:00:00.000Z",
  provenance: "referenced",
};
const item: LibraryItem = { ...v1Item, formats: [epubFormat], tags: [] };

describe("libraryItemSchema", () => {
  it("requires the authoritative nonempty format aggregate", () => {
    expect(libraryItemSchema.parse(item)).toEqual(item);
    expect(() => libraryItemSchema.parse(v1Item)).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, formats: [] })).toThrow();
  });

  it("validates EPUB and PDF as a unique nonempty format list", () => {
    expect(bookFormatsSchema.parse([epubFormat, pdfFormat])).toEqual([
      epubFormat,
      pdfFormat,
    ]);
    expect(
      libraryItemSchema.parse({ ...item, formats: [epubFormat, pdfFormat] }),
    ).toMatchObject({ formats: [epubFormat, pdfFormat] });
    expect(() => bookFormatsSchema.parse([])).toThrow();
  });

  it("requires explicit managed or referenced provenance for every format", () => {
    expect(BOOK_FORMAT_PROVENANCES).toEqual(["managed", "referenced"]);
    expect(bookFormatSchema.parse(epubFormat)).toEqual(epubFormat);
    expect(bookFormatSchema.parse(pdfFormat)).toEqual(pdfFormat);
    expect(() =>
      bookFormatSchema.parse({
        sourcePath: epubFormat.sourcePath,
        format: epubFormat.format,
        addedAt: epubFormat.addedAt,
      }),
    ).toThrow();
    expect(() =>
      bookFormatSchema.parse({ ...epubFormat, provenance: "borrowed" }),
    ).toThrow();
  });

  it("requires the legacy aliases to identify the primary supplied format", () => {
    expect(
      libraryItemSchema.parse({
        ...item,
        sourcePath: pdfFormat.sourcePath,
        format: pdfFormat.format,
        formats: [pdfFormat, epubFormat],
      }),
    ).toMatchObject({
      sourcePath: pdfFormat.sourcePath,
      format: pdfFormat.format,
      formats: [pdfFormat, epubFormat],
    });
    expect(() =>
      libraryItemSchema.parse({ ...item, formats: [pdfFormat, epubFormat] }),
    ).toThrow();
    expect(() =>
      libraryItemSchema.parse({
        ...item,
        sourcePath: "library/another.epub",
        formats: [epubFormat, pdfFormat],
      }),
    ).toThrow();
    expect(() =>
      libraryItemSchema.parse({
        ...item,
        format: "pdf",
        formats: [epubFormat, pdfFormat],
      }),
    ).toThrow();
  });

  it("keeps the item and per-format added timestamps independent", () => {
    expect(
      libraryItemSchema.parse({
        ...item,
        formats: [{ ...epubFormat, addedAt: "2026-07-19T09:00:00.000Z" }],
      }),
    ).toMatchObject({
      addedAt: item.addedAt,
      formats: [{ addedAt: "2026-07-19T09:00:00.000Z" }],
    });
  });

  it("accepts RFC3339 offsets emitted by native engines", () => {
    expect(
      libraryItemSchema.parse({
        ...item,
        addedAt: "2026-07-18T12:00:00+00:00",
        updatedAt: "2026-07-18T08:00:00-04:00",
        formats: [{ ...epubFormat, addedAt: "2026-07-18T14:00:00+02:00" }],
      }),
    ).toMatchObject({
      addedAt: "2026-07-18T12:00:00+00:00",
      updatedAt: "2026-07-18T08:00:00-04:00",
      formats: [{ addedAt: "2026-07-18T14:00:00+02:00" }],
    });
  });

  it("rejects duplicate book format IDs", () => {
    expect(() =>
      bookFormatsSchema.parse([
        epubFormat,
        {
          ...epubFormat,
          sourcePath: "library/left-hand-copy.epub",
          provenance: "referenced",
        },
      ]),
    ).toThrow();
  });

  it("rejects malformed nested book format data", () => {
    expect(() =>
      bookFormatsSchema.parse([{ ...epubFormat, addedAt: "yesterday" }]),
    ).toThrow();
    expect(() =>
      bookFormatSchema.parse({ ...epubFormat, checksum: "unexpected" }),
    ).toThrow();
  });

  it("normalizes user tags while preserving their first display spelling", () => {
    expect(normalizeTags(["  Science   Fiction  ", "Classic"])).toEqual([
      "Science Fiction",
      "Classic",
    ]);
    expect(
      libraryItemSchema.parse({ ...item, tags: ["  Science   Fiction  ", "Classic"] }),
    ).toMatchObject({ tags: ["Science Fiction", "Classic"] });
  });

  it("rejects blank optional metadata and duplicate normalized tags", () => {
    expect(() => libraryItemSchema.parse({ ...item, author: "  " })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, description: "" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, coverPath: " " })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, tags: ["Classic", " classic "] })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, tags: [" "] })).toThrow();
  });

  it("adds ordered structured authors without replacing the legacy author", () => {
    const authors: readonly BookAuthor[] = [
      { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
      { name: "Virginia Kidd" },
    ];

    expect(libraryItemSchema.parse({ ...item, author: "Ursula K. Le Guin", authors })).toMatchObject(
      { author: "Ursula K. Le Guin", authors },
    );
    expect(bookAuthorSchema.parse(authors[0])).toEqual(authors[0]);
    expect(() => libraryItemSchema.parse({ ...item, authors: [] })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, authors: [{ name: " " }] })).toThrow();
  });

  it("validates richer scalar metadata and identifier values", () => {
    const identifiers: BookIdentifiers = {
      isbn: "978-0-441-47812-5",
      goodreads: "18423",
    };
    const metadata = {
      series: "Hainish Cycle",
      seriesIndex: 4.5,
      publisher: "Ace Books",
      identifiers,
      rating: 8.5,
    };

    expect(libraryItemSchema.parse({ ...item, ...metadata })).toMatchObject(metadata);
    expect(bookIdentifiersSchema.parse(identifiers)).toEqual(identifiers);
    expect(() => libraryItemSchema.parse({ ...item, series: " " })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, seriesIndex: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, identifiers: { isbn: " " } })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, rating: -0.1 })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, rating: 10.1 })).toThrow();
  });

  it("bounds extensible text metadata without inventing typed columns", () => {
    const metadata: BookCustomMetadata = { acquisition_source: "Local bookshop" };
    expect(bookCustomMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(libraryItemSchema.parse({ ...item, customMetadata: metadata })).toMatchObject({
      customMetadata: metadata,
    });
    expect(bookCustomMetadataSchema.safeParse({ "Bad Key": "value" }).success).toBe(false);
    expect(
      bookCustomMetadataSchema.safeParse(
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field_${index}`, "value"])),
      ).success,
    ).toBe(false);
  });

  it("preserves language order and publication-date precision", () => {
    const languages = ["en-US", "fr", "zh-Hant"] as const;

    expect(libraryItemSchema.parse({ ...item, languages })).toMatchObject({ languages });
    expect(languageTagSchema.parse("en-US")).toBe("en-US");
    expect(() => libraryItemSchema.parse({ ...item, languages: [] })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, languages: ["English (US)"] })).toThrow();

    for (const publishedDate of ["1969", "1969-03", "1969-03-01"]) {
      expect(publishedDateSchema.parse(publishedDate)).toBe(publishedDate);
      expect(libraryItemSchema.parse({ ...item, publishedDate })).toMatchObject({ publishedDate });
    }
    expect(() => publishedDateSchema.parse("1969-13")).toThrow();
    expect(() => publishedDateSchema.parse("1969-02-29")).toThrow();
    expect(() => publishedDateSchema.parse("1969-03-01T00:00:00Z")).toThrow();
  });

  it("keeps the legacy scalar-author item shape compatible", () => {
    const legacyMetadataItem = { ...item, author: "Ursula K. Le Guin" };

    expect(libraryItemSchema.parse(legacyMetadataItem)).toEqual(legacyMetadataItem);
  });

  it("rejects missing or invalid library fields", () => {
    expect(() => libraryItemSchema.parse({ ...item, id: "" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, title: "" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, sourcePath: "" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, format: "mp3" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...item, addedAt: "yesterday" })).toThrow();
  });
});

describe("InMemoryLibraryRepository", () => {
  it("adds and retrieves a validated item by ID", () => {
    const repository = new InMemoryLibraryRepository();

    repository.add(item);

    expect(repository.get(item.id)).toEqual(item);
  });

  it("rejects duplicate IDs instead of replacing an item", () => {
    const repository = new InMemoryLibraryRepository();
    repository.add(item);

    expect(() => repository.add({ ...item, title: "A different book" })).toThrow(
      `Library item '${item.id}' already exists.`,
    );
    expect(repository.get(item.id)).toEqual(item);
  });

  it("lists items without exposing the repository collection", () => {
    const repository = new InMemoryLibraryRepository();
    repository.add(item);

    const listed = repository.list();
    listed.pop();

    expect(repository.list()).toEqual([item]);
  });

  it("returns undefined when retrieving an unknown ID", () => {
    expect(new InMemoryLibraryRepository().get("unknown")).toBeUndefined();
  });

  it("removes and returns an existing item", () => {
    const repository = new InMemoryLibraryRepository();
    repository.add(item);

    expect(repository.remove(item.id)).toEqual(item);
    expect(repository.list()).toEqual([]);
  });

  it("returns undefined when removing an unknown ID", () => {
    expect(new InMemoryLibraryRepository().remove("unknown")).toBeUndefined();
  });
});
