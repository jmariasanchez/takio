import { describe, expect, it } from "bun:test";

import {
  InMemoryLibraryRepository,
  libraryItemSchema,
  type LibraryItem,
} from "../src/index.js";

const item: LibraryItem = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "library/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
};

describe("libraryItemSchema", () => {
  it("accepts a complete library item", () => {
    expect(libraryItemSchema.parse(item)).toEqual(item);
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
