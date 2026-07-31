import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FormatId, LibraryItem } from "@takio/core";
import type {
  QueryLibraryItemsRequest,
  SavedLibraryViewDefinition,
} from "@takio/library-contract";

import { BunSqliteLibraryStore } from "../src/index.js";
import { queryTestSeam } from "../src/query-test-seam.js";

const addedAt = "2026-07-20T10:00:00.000Z";

function item(
  id: string,
  title: string,
  format: FormatId,
  metadata: Partial<LibraryItem>,
): LibraryItem {
  const sourcePath = `/referenced/${id}.${format}`;
  return {
    id,
    title,
    sourcePath,
    format,
    addedAt,
    formats: [{ sourcePath, format, addedAt, provenance: "referenced" }],
    tags: [],
    ...metadata,
  };
}

const fixtures: LibraryItem[] = [
  item("a", "100% Hainish", "epub", {
    author: "Ursula K. Le Guin",
    authors: [{ name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." }],
    series: "Hainish",
    seriesIndex: 1,
    languages: ["en"],
    identifiers: { isbn: "9780441478125" },
    rating: 8,
    tags: ["Classic"],
  }),
  item("b", "Kindred", "mobi", {
    author: "Octavia E. Butler",
    authors: [{ name: "Octavia E. Butler", sortName: "Butler, Octavia E." }],
    series: "Patternist",
    languages: ["en"],
    description: "An under_score marker.",
    tags: ["Classic"],
  }),
  item("c", "The Dispossessed", "pdf", {
    author: "Ursula K. Le Guin",
    authors: [{ name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." }],
    series: "Hainish",
    seriesIndex: 2,
    publisher: "Back\\Slash Press",
    languages: ["fr"],
    rating: 2,
    tags: ["Modern"],
  }),
  item("d", 'title:"darkness"', "azw3", {
    author: "N. K. Jemisin",
    authors: [{ name: "N. K. Jemisin", sortName: "Jemisin, N. K." }],
    series: "Broken Earth",
    languages: ["fr"],
    tags: ["Classic"],
  }),
  item("e", "Anonymous", "txt", { tags: [] }),
];

function request(
  overrides: Partial<QueryLibraryItemsRequest> = {},
): QueryLibraryItemsRequest {
  return {
    query: "",
    filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
    sort: { field: "title", direction: "ascending" },
    page: { offset: 0, limit: 100 },
    ...overrides,
  };
}

const savedDefinition: SavedLibraryViewDefinition = {
  version: 1,
  query: "Hainish",
  filters: { authors: [], tags: [], series: [], languages: [], formats: ["epub"] },
  sort: { field: "author", direction: "ascending" },
};

describe("BunSqliteLibraryStore catalogue queries", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-query-"));
    databasePath = join(directory, "library.sqlite");
    stores = [];
  });

  afterEach(async () => {
    delete queryTestSeam.beforeHydrationQuery;
    for (const store of stores) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): BunSqliteLibraryStore {
    const store = new BunSqliteLibraryStore(databasePath);
    stores.push(store);
    return store;
  }

  async function populatedStore(): Promise<BunSqliteLibraryStore> {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    for (const fixture of fixtures) {
      expect((await store.add({ item: fixture })).ok).toBe(true);
    }
    return store;
  }

  it("pages OR-within/AND-across matches and computes self-excluding facets", async () => {
    const store = await populatedStore();
    const hydrationQueries: string[] = [];
    queryTestSeam.beforeHydrationQuery = (relation) => hydrationQueries.push(relation);

    const result = await store.query(
      request({
        filters: {
          authors: ["Ursula K. Le Guin", "Octavia E. Butler"],
          tags: ["Classic"],
          series: [],
          languages: [],
          formats: [],
        },
        page: { offset: 0, limit: 1 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
    expect(result.value.items.map(({ id }) => id)).toEqual(["a"]);
    expect(hydrationQueries).toEqual([
      "formats",
      "tags",
      "authors",
      "languages",
      "identifiers",
      "customMetadata",
    ]);
    expect(result.value.facets.authors).toEqual([
      { value: "N. K. Jemisin", count: 1 },
      { value: "Octavia E. Butler", count: 1 },
      { value: "Ursula K. Le Guin", count: 1 },
    ]);
    expect(result.value.facets.tags).toEqual([
      { value: "Classic", count: 2 },
      { value: "Modern", count: 1 },
    ]);
    expect(result.value.facets.series).toEqual([
      { value: "Hainish", count: 1 },
      { value: "Patternist", count: 1 },
    ]);
    expect(result.value.facets.languages).toEqual([{ value: "en", count: 2 }]);
    expect(result.value.facets.formats).toEqual([
      { value: "epub", count: 1 },
      { value: "mobi", count: 1 },
    ]);

    const largerPage = await store.query(request());
    expect(largerPage.ok && largerPage.value.items).toHaveLength(5);
    expect(hydrationQueries).toEqual([
      "formats",
      "tags",
      "authors",
      "languages",
      "identifiers",
      "customMetadata",
      "formats",
      "tags",
      "authors",
      "languages",
      "identifiers",
      "customMetadata",
    ]);

    const crossFacet = await store.query(
      request({
        filters: {
          authors: ["Ursula K. Le Guin", "Octavia E. Butler"],
          tags: ["Classic"],
          series: [],
          languages: ["fr"],
          formats: [],
        },
      }),
    );
    expect(crossFacet.ok && crossFacet.value.total).toBe(0);
  });

  it("treats search text literally across scalar and relation metadata", async () => {
    const store = await populatedStore();
    for (const [query, expected] of [
      ["%", ["a"]],
      ["_", ["b"]],
      ["\\", ["c"]],
      ['title:"darkness"', ["d"]],
      ["Le Guin,", ["a", "c"]],
      ["9780441478125", ["a"]],
    ] as const) {
      const result = await store.query(request({ query }));
      expect(result.ok && result.value.items.map(({ id }) => id)).toEqual(expected);
    }
  });

  it("uses deterministic nulls-last sorts and validates runtime page bounds", async () => {
    const store = await populatedStore();
    const expected = {
      title: {
        ascending: ["a", "e", "b", "c", "d"],
        descending: ["d", "c", "b", "e", "a"],
      },
      author: {
        ascending: ["b", "d", "a", "c", "e"],
        descending: ["a", "c", "d", "b", "e"],
      },
      series: {
        ascending: ["d", "a", "c", "b", "e"],
        descending: ["b", "c", "a", "d", "e"],
      },
      publishedDate: {
        ascending: ["a", "b", "c", "d", "e"],
        descending: ["a", "b", "c", "d", "e"],
      },
      rating: {
        ascending: ["c", "a", "b", "d", "e"],
        descending: ["a", "c", "b", "d", "e"],
      },
      addedAt: {
        ascending: ["a", "b", "c", "d", "e"],
        descending: ["a", "b", "c", "d", "e"],
      },
      updatedAt: {
        ascending: ["a", "b", "c", "d", "e"],
        descending: ["a", "b", "c", "d", "e"],
      },
    } as const;
    for (const [field, directions] of Object.entries(expected)) {
      for (const [direction, ids] of Object.entries(directions)) {
        const sorted = await store.query(
          request({
            sort: {
              field: field as QueryLibraryItemsRequest["sort"]["field"],
              direction: direction as QueryLibraryItemsRequest["sort"]["direction"],
            },
          }),
        );
        expect(sorted.ok && sorted.value.items.map(({ id }) => id)).toEqual(ids);
      }
    }

    const beyond = await store.query(request({ page: { offset: 99, limit: 2 } }));
    expect(beyond.ok && { total: beyond.value.total, ids: beyond.value.items.map(({ id }) => id) }).toEqual({
      total: 5,
      ids: [],
    });

    expect(
      await store.query(
        request({ page: { offset: 0, limit: 101 } }) as unknown as QueryLibraryItemsRequest,
      ),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(
      await store.query(
        request({ page: { offset: 1e20, limit: 1 } }) as unknown as QueryLibraryItemsRequest,
      ),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
  });

  it("persists saved views, preserves createdAt on upsert, and removes idempotently", async () => {
    const first = await populatedStore();
    const created = await first.saveSavedView({
      id: "favourites",
      name: "  Favourites  ",
      definition: savedDefinition,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.name).toBe("Favourites");

    const updated = await first.saveSavedView({
      id: "favourites",
      name: "Best books",
      definition: { ...savedDefinition, query: "Classic" },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.createdAt).toBe(created.value.createdAt);
    first.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.listSavedViews({})).toEqual({ ok: true, value: [updated.value] });
    expect(await reopened.removeSavedView({ id: "favourites" })).toEqual({
      ok: true,
      value: updated.value,
    });
    expect(await reopened.removeSavedView({ id: "favourites" })).toEqual({ ok: true, value: null });
    expect(await reopened.listSavedViews({})).toEqual({ ok: true, value: [] });
  });

  it("rejects malformed saved-view requests and reports malformed persisted definitions", async () => {
    const store = await populatedStore();
    expect(
      await store.saveSavedView({
        id: "bad",
        name: "",
        definition: savedDefinition,
      }),
    ).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    expect(await store.listSavedViews({ extra: true } as never)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });

    const valid = await store.saveSavedView({ id: "corrupt", name: "Corrupt", definition: savedDefinition });
    expect(valid.ok).toBe(true);
    store.close();
    using database = new Database(databasePath, { strict: true });
    database.run("UPDATE saved_library_views SET definition_json = ? WHERE id = ?", [
      JSON.stringify({ ...savedDefinition, version: 2 }),
      "corrupt",
    ]);
    database.close();

    const reopened = createStore();
    expect(await reopened.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await reopened.listSavedViews({})).toEqual({
      ok: false,
      error: { code: "invalid-stored-data" },
    });
  });
});
