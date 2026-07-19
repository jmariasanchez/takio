import { describe, expect, it } from "bun:test";

import {
  InMemoryLibraryRepository,
  bookFormatSchema,
  bookFormatsSchema,
  libraryItemSchema,
  normalizeTags,
  type BookFormat,
  type LibraryItem,
} from "../src/index.js";

const v1Item = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
} as const;
const item: LibraryItem = { ...v1Item, tags: [] };
const epubFormat: BookFormat = {
  sourcePath: v1Item.sourcePath,
  format: "epub",
  addedAt: v1Item.addedAt,
};
const pdfFormat: BookFormat = {
  sourcePath: "library/left-hand.pdf",
  format: "pdf",
  addedAt: "2026-07-19T12:00:00.000Z",
};

describe("libraryItemSchema", () => {
  it("gives v1 items a lossless empty metadata representation", () => {
    const parsed = libraryItemSchema.parse(v1Item);

    expect(parsed).toEqual(item);
    expect("formats" in parsed).toBe(false);
  });

  it("validates EPUB and PDF as a unique nonempty format list", () => {
    expect(bookFormatsSchema.parse([epubFormat, pdfFormat])).toEqual([
      epubFormat,
      pdfFormat,
    ]);
    expect(() => bookFormatsSchema.parse([])).toThrow();
  });

  it("rejects duplicate book format IDs", () => {
    expect(() =>
      bookFormatsSchema.parse([
        epubFormat,
        { ...epubFormat, sourcePath: "library/left-hand-copy.epub" },
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
      libraryItemSchema.parse({ ...v1Item, tags: ["  Science   Fiction  ", "Classic"] }),
    ).toMatchObject({ tags: ["Science Fiction", "Classic"] });
  });

  it("rejects blank optional metadata and duplicate normalized tags", () => {
    expect(() => libraryItemSchema.parse({ ...v1Item, author: "  " })).toThrow();
    expect(() => libraryItemSchema.parse({ ...v1Item, description: "" })).toThrow();
    expect(() => libraryItemSchema.parse({ ...v1Item, coverPath: " " })).toThrow();
    expect(() => libraryItemSchema.parse({ ...v1Item, tags: ["Classic", " classic "] })).toThrow();
    expect(() => libraryItemSchema.parse({ ...v1Item, tags: [" "] })).toThrow();
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
