import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { libraryQueryPageSchema } from "../packages/library-contract/dist/index.js";

const ITEM_COUNT = 10_000;
const SECONDARY_FORMAT_COUNT = 5_000;
const SAMPLE_COUNT = 20;
const WARMUP_COUNT = 3;
const INITIAL_P95_BUDGET_MILLISECONDS = 300;
const mode = process.env.TAKIO_NATIVE_LIBRARY_QUERY_BENCHMARK;

if (mode !== "report" && mode !== "enforce") {
  throw new Error("TAKIO_NATIVE_LIBRARY_QUERY_BENCHMARK must be 'report' or 'enforce'.");
}

const base = process.env.JCODE_SCRATCH_DIR ?? process.env.RUNNER_TEMP ?? tmpdir();
const root = await mkdtemp(join(base, "takio-native-query-"));
const binary = process.env.TAKIO_NATIVE_LIBRARY_QUERY_EXECUTABLE ?? join(process.cwd(), "target", "release", "takio");
const databasePath = join(root, "library.sqlite");
const seedPath = join(root, "seed.epub");

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

const request = {
  query: "Signal",
  filters: {
    authors: authors.slice(0, 50),
    tags: tags.slice(0, 4),
    series: series.slice(0, 12),
    languages: languages.slice(0, 2),
    formats: ["pdf"],
  },
  sort: { field: "author", direction: "ascending" },
  page: { offset: 0, limit: 100 },
} as const;

function runQuery(): number {
  const started = performance.now();
  const result = spawnSync(
    binary,
    ["library", "query", "--db", databasePath, "--request-json", JSON.stringify(request)],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const elapsed = performance.now() - started;
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`Native query failed: ${result.stdout}${result.stderr}`);
  }
  const envelope = JSON.parse(result.stdout) as { ok?: unknown; value?: unknown };
  if (envelope.ok !== true) throw new Error("Native query returned a failure envelope.");
  const parsed = libraryQueryPageSchema.safeParse(envelope.value);
  if (!parsed.success || parsed.data.items.length === 0 || parsed.data.total < parsed.data.items.length) {
    throw new Error("Native query returned an invalid or empty result page.");
  }
  return elapsed;
}

try {
  await writeFile(seedPath, "seed");
  const initialized = spawnSync(
    binary,
    ["library", "add", "--db", databasePath, "--source-path", seedPath],
    { encoding: "utf8" },
  );
  if (initialized.status !== 0 || initialized.stderr !== "") {
    throw new Error(`Could not initialize native benchmark store: ${initialized.stdout}${initialized.stderr}`);
  }

  const database = new Database(databasePath);
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
  database.exec("DELETE FROM library_items;");
  const insertItem = database.prepare(
    "INSERT INTO library_items(id,title,added_at,author,series,series_index,publisher,published_date,rating,description,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertFormat = database.prepare(
    "INSERT INTO library_item_formats(library_item_id,format,source_path,added_at,provenance,position) VALUES(?,?,?,?,?,?)",
  );
  const insertAuthor = database.prepare(
    "INSERT INTO library_item_authors(library_item_id,name,sort_name,position) VALUES(?,?,?,0)",
  );
  const insertLanguage = database.prepare(
    "INSERT INTO library_item_languages(library_item_id,language,position) VALUES(?,?,0)",
  );
  const insertIdentifier = database.prepare(
    "INSERT INTO library_item_identifiers(library_item_id,scheme,value) VALUES(?,'fixture',?)",
  );
  const insertTag = database.prepare(
    "INSERT OR IGNORE INTO tags(normalized_name,name) VALUES(?,?)",
  );
  const insertItemTag = database.prepare(
    "INSERT INTO library_item_tags(library_item_id,tag_normalized_name,position) VALUES(?,?,0)",
  );

  for (let index = 0; index < ITEM_COUNT; index += 1) {
    const id = `book-${index.toString().padStart(5, "0")}`;
    const authorIndex = index % authors.length;
    const author = authors[authorIndex]!;
    const bookSeries = series[index % series.length]!;
    const tag = tags[index % tags.length]!;
    const normalizedTag = tag.toLowerCase();
    const addedAt = `2026-01-${((index % 28) + 1).toString().padStart(2, "0")}T12:00:00.000Z`;

    insertItem.run(
      id,
      `${index % 2 === 0 ? "Signal" : "Archive"} volume ${id}`,
      addedAt,
      author,
      bookSeries,
      (index % 12) + 1,
      `Publisher ${(index % 13).toString().padStart(2, "0")}`,
      String(1980 + (index % 45)),
      index % 11,
      `Deterministic catalogue record ${index}.`,
      addedAt,
    );
    insertFormat.run(id, "epub", `/reference-catalogue/${id}.epub`, addedAt, "referenced", 0);
    if (index % 2 === 0) {
      insertFormat.run(id, "pdf", `/reference-catalogue/${id}.pdf`, addedAt, "referenced", 1);
    }
    insertAuthor.run(id, author, `Writer ${authorIndex.toString().padStart(3, "0")}`);
    insertLanguage.run(id, languages[index % languages.length]!);
    insertIdentifier.run(id, id);
    insertTag.run(normalizedTag, tag);
    insertItemTag.run(id, normalizedTag);
  }
  database.exec("COMMIT;");
  database.close();

  for (let index = 0; index < WARMUP_COUNT; index += 1) runQuery();
  const samples = Array.from({ length: SAMPLE_COUNT }, runQuery).sort((left, right) => left - right);
  const p50 = samples[Math.floor(SAMPLE_COUNT * 0.5) - 1]!;
  const p95 = samples[Math.ceil(SAMPLE_COUNT * 0.95) - 1]!;
  const result = {
    implementation: "rust",
    items: ITEM_COUNT,
    formats: ITEM_COUNT + SECONDARY_FORMAT_COUNT,
    samples: SAMPLE_COUNT,
    p50Milliseconds: Number(p50.toFixed(2)),
    p95Milliseconds: Number(p95.toFixed(2)),
    budgetMilliseconds: INITIAL_P95_BUDGET_MILLISECONDS,
    roadmapTargetMilliseconds: 150,
  };
  console.log(JSON.stringify(result));
  if (mode === "enforce" && p95 > INITIAL_P95_BUDGET_MILLISECONDS) {
    throw new Error(
      `Native library query p95 ${p95.toFixed(2)} ms exceeded ${INITIAL_P95_BUDGET_MILLISECONDS} ms.`,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
