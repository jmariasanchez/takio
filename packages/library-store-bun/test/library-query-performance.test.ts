import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";
import {
  libraryQueryPageSchema,
  type LibraryFacetCounts,
  type QueryLibraryItemsRequest,
} from "@takio/library-contract";

import { BunSqliteLibraryStore } from "../src/index.js";
import { queryTestSeam } from "../src/query-test-seam.js";

const ITEM_COUNT = 10_000;
const SECONDARY_FORMAT_COUNT = 5_000;
const PAGE_SIZE = 100;
const ROADMAP_P95_MILLISECONDS = 150;
const ROADMAP_DATA_LAYER_COLD_READY_MILLISECONDS = 2_000;
const BENCHMARK_SAMPLES = 20;
const BENCHMARK_WARMUPS = 3;
const BENCHMARK_MODE = process.env.TAKIO_LIBRARY_QUERY_BENCHMARK;
const FIXTURE_OUTPUT = process.env.TAKIO_LIBRARY_QUERY_FIXTURE_OUTPUT;
const HYDRATION_RELATIONS = [
  "formats",
  "tags",
  "authors",
  "languages",
  "identifiers",
  "customMetadata",
] as const;

if (
  BENCHMARK_MODE !== undefined &&
  BENCHMARK_MODE !== "report" &&
  BENCHMARK_MODE !== "enforce"
) {
  throw new Error(
    "TAKIO_LIBRARY_QUERY_BENCHMARK must be unset, 'report', or 'enforce'.",
  );
}
if (FIXTURE_OUTPUT === "") {
  throw new Error("TAKIO_LIBRARY_QUERY_FIXTURE_OUTPUT must not be empty.");
}

const authors = Array.from({ length: 97 }, (_, index) =>
  `Author ${index.toString().padStart(3, "0")}`,
);
const series = Array.from({ length: 23 }, (_, index) =>
  `Series ${index.toString().padStart(2, "0")}`,
);
const tags = [
  "Classic",
  "Research",
  "Reference",
  "Award winner",
  "Contemporary",
  "History",
  "Science",
] as const;
const languages = ["en", "fr", "de"] as const;

function catalogueItem(index: number): LibraryItem {
  const id = `book-${index.toString().padStart(5, "0")}`;
  const authorIndex = index % authors.length;
  const author = authors[authorIndex]!;
  const primaryPath = `/reference-catalogue/${id}.epub`;
  const addedAt = `2026-01-${((index % 28) + 1).toString().padStart(2, "0")}T12:00:00.000Z`;
  const formats: LibraryItem["formats"] = [
    {
      sourcePath: primaryPath,
      format: "epub",
      addedAt,
      provenance: "referenced",
    },
    ...(index % 2 === 0
      ? [
          {
            sourcePath: `/reference-catalogue/${id}.pdf`,
            format: "pdf" as const,
            addedAt,
            provenance: "referenced" as const,
          },
        ]
      : []),
  ];

  return {
    id,
    title: `${index % 2 === 0 ? "Signal" : "Archive"} volume ${id}`,
    sourcePath: primaryPath,
    format: "epub",
    addedAt,
    formats,
    author,
    authors: [{ name: author, sortName: `Writer ${authorIndex.toString().padStart(3, "0")}` }],
    series: series[index % series.length],
    seriesIndex: (index % 12) + 1,
    publisher: `Publisher ${(index % 13).toString().padStart(2, "0")}`,
    languages: [languages[index % languages.length]!],
    identifiers: { fixture: id },
    publishedDate: `${1980 + (index % 45)}`,
    rating: index % 11,
    description: `Deterministic catalogue record ${index}.`,
    tags: [tags[index % tags.length]!],
    updatedAt: addedAt,
  };
}

const catalogue = Array.from({ length: ITEM_COUNT }, (_, index) => catalogueItem(index));

const request: QueryLibraryItemsRequest = {
  query: "Signal",
  filters: {
    authors: authors.slice(0, 50),
    tags: tags.slice(0, 4),
    series: series.slice(0, 12),
    languages: languages.slice(0, 2),
    formats: ["pdf"],
  },
  sort: { field: "author", direction: "ascending" },
  page: { offset: 0, limit: PAGE_SIZE },
};

const coldReadyRequest: QueryLibraryItemsRequest = {
  query: "",
  filters: {
    authors: [],
    tags: [],
    series: [],
    languages: [],
    formats: [],
  },
  sort: { field: "title", direction: "ascending" },
  page: { offset: 0, limit: 25 },
};

type Facet = keyof LibraryFacetCounts;

function includesCaseInsensitive(values: readonly string[], value: string): boolean {
  const normalized = value.toLowerCase();
  return values.some((candidate) => candidate.toLowerCase() === normalized);
}

function matches(item: LibraryItem, omittedFacet?: Facet): boolean {
  if (!item.title.toLowerCase().includes(request.query.toLowerCase())) return false;
  const itemAuthors = item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []);
  if (
    omittedFacet !== "authors" &&
    !itemAuthors.some((author) => includesCaseInsensitive(request.filters.authors, author))
  ) {
    return false;
  }
  if (
    omittedFacet !== "tags" &&
    !item.tags.some((tag) => includesCaseInsensitive(request.filters.tags, tag))
  ) {
    return false;
  }
  if (
    omittedFacet !== "series" &&
    (!item.series || !includesCaseInsensitive(request.filters.series, item.series))
  ) {
    return false;
  }
  if (
    omittedFacet !== "languages" &&
    !(item.languages ?? []).some((language) =>
      includesCaseInsensitive(request.filters.languages, language),
    )
  ) {
    return false;
  }
  if (
    omittedFacet !== "formats" &&
    !item.formats.some(({ format }) => request.filters.formats.includes(format))
  ) {
    return false;
  }
  return true;
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function expectedFacet(
  facet: Facet,
  values: (item: LibraryItem) => readonly string[],
): { value: string; count: number }[] {
  const counts = new Map<string, { value: string; ids: Set<string> }>();
  for (const item of catalogue) {
    if (!matches(item, facet)) continue;
    for (const value of values(item)) {
      const key = value.toLowerCase();
      const current = counts.get(key) ?? { value, ids: new Set<string>() };
      current.ids.add(item.id);
      counts.set(key, current);
    }
  }
  return [...counts.values()]
    .map(({ value, ids }) => ({ value, count: ids.size }))
    .sort((left, right) => compareText(left.value, right.value));
}

function expectedResult(): {
  items: readonly LibraryItem[];
  total: number;
  facets: LibraryFacetCounts;
} {
  const matching = catalogue.filter((item) => matches(item));
  matching.sort((left, right) => {
    const leftAuthor = left.authors?.[0]?.sortName ?? left.authors?.[0]?.name ?? left.author ?? "";
    const rightAuthor = right.authors?.[0]?.sortName ?? right.authors?.[0]?.name ?? right.author ?? "";
    return compareText(leftAuthor, rightAuthor) || compareText(left.id, right.id);
  });
  return {
    items: matching.slice(0, PAGE_SIZE),
    total: matching.length,
    facets: {
      authors: expectedFacet("authors", (item) =>
        item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []),
      ),
      tags: expectedFacet("tags", (item) => item.tags),
      series: expectedFacet("series", (item) => (item.series ? [item.series] : [])),
      languages: expectedFacet("languages", (item) => item.languages ?? []),
      formats: expectedFacet("formats", (item) => item.formats.map(({ format }) => format)),
    },
  };
}

function seedCatalogue(databasePath: string): void {
  using database = new Database(databasePath, { strict: true });
  const insertItem = database.prepare(`
    INSERT INTO library_items
      (id, title, added_at, author, series, series_index, publisher,
        published_date, rating, description, cover_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  const insertFormat = database.prepare(`
    INSERT INTO library_item_formats
      (library_item_id, format, source_path, added_at, provenance, position)
    VALUES (?, ?, ?, ?, 'referenced', ?)
  `);
  const insertAuthor = database.prepare(`
    INSERT INTO library_item_authors
      (library_item_id, name, sort_name, position)
    VALUES (?, ?, ?, 0)
  `);
  const insertLanguage = database.prepare(`
    INSERT INTO library_item_languages
      (library_item_id, language, position)
    VALUES (?, ?, 0)
  `);
  const insertIdentifier = database.prepare(`
    INSERT INTO library_item_identifiers (library_item_id, scheme, value)
    VALUES (?, 'fixture', ?)
  `);
  const insertTag = database.prepare(
    "INSERT OR IGNORE INTO tags (normalized_name, name) VALUES (?, ?)",
  );
  const linkTag = database.prepare(`
    INSERT INTO library_item_tags
      (library_item_id, tag_normalized_name, position)
    VALUES (?, ?, 0)
  `);

  try {
    database.transaction(() => {
      for (const tag of tags) insertTag.run(tag.toLowerCase(), tag);
      for (const item of catalogue) {
        insertItem.run(
          item.id,
          item.title,
          item.addedAt,
          item.author!,
          item.series!,
          item.seriesIndex!,
          item.publisher!,
          item.publishedDate!,
          item.rating!,
          item.description!,
          item.updatedAt!,
        );
        for (const [position, format] of item.formats.entries()) {
          insertFormat.run(
            item.id,
            format.format,
            format.sourcePath,
            format.addedAt,
            position,
          );
        }
        insertAuthor.run(item.id, item.authors![0]!.name, item.authors![0]!.sortName!);
        insertLanguage.run(item.id, item.languages![0]!);
        insertIdentifier.run(item.id, item.identifiers!.fixture!);
        linkTag.run(item.id, item.tags[0]!.toLowerCase());
      }
    }).immediate();
    database.run("ANALYZE");
  } finally {
    insertItem.finalize();
    insertFormat.finalize();
    insertAuthor.finalize();
    insertLanguage.finalize();
    insertIdentifier.finalize();
    insertTag.finalize();
    linkTag.finalize();
  }
}

function percentile(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1]!;
}

test(
  "queries a 10,000-book v5 catalogue with bounded hydration and an opt-in p95 gate",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "takio-library-query-performance-"));
    const databasePath = join(directory, "library.sqlite");
    const store = new BunSqliteLibraryStore(databasePath);

    try {
      expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
      store.close();
      seedCatalogue(databasePath);
      if (FIXTURE_OUTPUT) {
        await copyFile(databasePath, FIXTURE_OUTPUT);
      }

      const coldReadyStartedAt = performance.now();
      const coldReadyStore = new BunSqliteLibraryStore(databasePath);
      const coldReadyOpenResult = await coldReadyStore.open({ config: {} });
      const coldReadyResult = coldReadyOpenResult.ok
        ? await coldReadyStore.query(coldReadyRequest)
        : coldReadyOpenResult;
      const coldReadyMilliseconds = performance.now() - coldReadyStartedAt;
      coldReadyStore.close();

      expect(coldReadyOpenResult).toEqual({ ok: true, value: null });
      expect(coldReadyResult.ok).toBe(true);
      if (!coldReadyResult.ok) return;
      expect(libraryQueryPageSchema.parse(coldReadyResult.value)).toEqual(
        coldReadyResult.value,
      );
      expect(coldReadyResult.value.total).toBe(ITEM_COUNT);
      expect(coldReadyResult.value.page).toEqual(coldReadyRequest.page);
      expect(coldReadyResult.value.items).toHaveLength(coldReadyRequest.page.limit);
      expect(
        Object.values(coldReadyResult.value.facets).every((facet) => facet.length > 0),
      ).toBe(true);
      if (BENCHMARK_MODE) {
        console.info(
          `[library-query] data-layer-cold-ready=${coldReadyMilliseconds.toFixed(1)}ms ` +
            `(fresh store open + default first page; excludes fixture seeding; ` +
            `not native window launch) roadmap<=${ROADMAP_DATA_LAYER_COLD_READY_MILLISECONDS}ms`,
        );
      }
      if (BENCHMARK_MODE === "enforce") {
        expect(coldReadyMilliseconds).toBeLessThanOrEqual(
          ROADMAP_DATA_LAYER_COLD_READY_MILLISECONDS,
        );
      }

      expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });

      const hydrationStatements: string[] = [];
      queryTestSeam.beforeHydrationQuery = (relation) => hydrationStatements.push(relation);
      const startedAt = performance.now();
      const result = await store.query(request);
      const normalSampleMilliseconds = performance.now() - startedAt;
      delete queryTestSeam.beforeHydrationQuery;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(libraryQueryPageSchema.parse(result.value)).toEqual(result.value);
      expect(hydrationStatements).toEqual(HYDRATION_RELATIONS);

      const expected = expectedResult();
      expect(result.value.total).toBe(expected.total);
      expect(result.value.items).toEqual(expected.items);
      expect(result.value.facets).toEqual(expected.facets);
      expect(result.value.page).toEqual({ offset: 0, limit: PAGE_SIZE });
      expect(result.value.items).toHaveLength(PAGE_SIZE);
      expect(catalogue.reduce((count, item) => count + item.formats.length, 0)).toBe(
        ITEM_COUNT + SECONDARY_FORMAT_COUNT,
      );

      console.info(
        `[library-query] deterministic sample: ${normalSampleMilliseconds.toFixed(1)}ms; ` +
          `${ITEM_COUNT} books, ${ITEM_COUNT + SECONDARY_FORMAT_COUNT} formats, ` +
          `${result.value.total} matches, ${hydrationStatements.length} batched hydration statements`,
      );

      if (!BENCHMARK_MODE) {
        console.warn(
          "[library-query] BENCHMARK GATE SKIPPED: set " +
            "TAKIO_LIBRARY_QUERY_BENCHMARK=report or =enforce.",
        );
        return;
      }

      for (let index = 0; index < BENCHMARK_WARMUPS; index += 1) {
        const warmup = await store.query(request);
        expect(warmup.ok).toBe(true);
      }
      const samples: number[] = [];
      for (let index = 0; index < BENCHMARK_SAMPLES; index += 1) {
        const sampleStartedAt = performance.now();
        const sample = await store.query(request);
        samples.push(performance.now() - sampleStartedAt);
        expect(sample.ok).toBe(true);
      }
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      console.info(
        `[library-query] benchmark mode=${BENCHMARK_MODE} samples=${BENCHMARK_SAMPLES} ` +
          `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
          `roadmap<=${ROADMAP_P95_MILLISECONDS}ms`,
      );
      if (BENCHMARK_MODE === "enforce") {
        expect(p95).toBeLessThanOrEqual(ROADMAP_P95_MILLISECONDS);
      }
    } finally {
      delete queryTestSeam.beforeHydrationQuery;
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
