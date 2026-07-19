import { describe, expect, it } from "bun:test";

import {
  InMemoryLibraryRepository,
  libraryItemSchema,
  normalizeTags,
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

describe("libraryItemSchema", () => {
  it("gives v1 items a lossless empty metadata representation", () => {
    expect(libraryItemSchema.parse(v1Item)).toEqual(item);
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
