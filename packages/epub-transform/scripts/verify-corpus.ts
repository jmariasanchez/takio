import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { EpubTransformError, transformEpubToKepub } from "../src/index.js";

type Entry = {
  id: string;
  path: string;
  source: string;
  license: string;
  redistribution: string;
  sha256: string;
  tags: string[];
  expected: "converted" | "rejected";
};

type Manifest = { version: 1; entries: Entry[] };

const manifestPath = resolve(import.meta.dir, "../corpus/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error("invalid-corpus-manifest");
}

const ids = new Set<string>();
const outcomes: Array<{ id: string; outcome: Entry["expected"] }> = [];
for (const entry of manifest.entries) {
  if (
    !entry.id || ids.has(entry.id) || !entry.path || !entry.source || !entry.license ||
    !entry.redistribution || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !Array.isArray(entry.tags) || !["converted", "rejected"].includes(entry.expected)
  ) {
    throw new Error(`invalid-corpus-entry:${entry.id || "unknown"}`);
  }
  ids.add(entry.id);
  const bytes = await readFile(resolve(import.meta.dir, "../corpus", entry.path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error(`corpus-digest-mismatch:${entry.id}`);

  try {
    transformEpubToKepub(bytes);
    if (entry.expected !== "converted") throw new Error(`unexpected-conversion:${entry.id}`);
  } catch (error) {
    if (!(error instanceof EpubTransformError) || entry.expected !== "rejected") throw error;
  }
  outcomes.push({ id: entry.id, outcome: entry.expected });
}

console.log(JSON.stringify({ ok: true, value: { cases: outcomes.length, outcomes } }));
