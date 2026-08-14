import { basename, extname } from "node:path";
import { libraryMetadataPatchSchema, type LibraryMetadataPatch } from "@takio/library-contract";

export const METADATA_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const MAX_METADATA_CANDIDATES = 8;
export const MAX_FILENAME_PATTERN_LENGTH = 240;

export type MetadataCandidateSource = "filename" | "embedded" | "online" | "manual";

export type MetadataCandidate = Readonly<{
  schemaVersion: typeof METADATA_CANDIDATE_SCHEMA_VERSION;
  id: string;
  source: MetadataCandidateSource;
  confidence: "low" | "medium" | "high";
  patch: LibraryMetadataPatch;
  provenance: Readonly<{
    generatedAt: string;
    itemId?: string;
    sourcePath?: string;
    pattern?: string;
    backend?: string;
  }>;
}>;

const BUILTIN_PATTERNS: readonly string[] = [
  "^(?<author>.+?) - (?<series>.+?) (?<seriesIndex>\\d+(?:\\.\\d+)?) - (?<title>.+)$",
  "^(?<author>.+?) - (?<title>.+?) \\((?<series>.+?) #(?<seriesIndex>\\d+(?:\\.\\d+)?)\\)$",
  "^(?<author>.+?) - (?<title>.+)$",
  "^(?<title>.+?) - (?<author>.+)$",
];

function cleanText(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function normalizedPatch(patch: LibraryMetadataPatch): LibraryMetadataPatch | null {
  const parsed = libraryMetadataPatchSchema.safeParse(patch);
  if (!parsed.success) return null;
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as LibraryMetadataPatch;
}

export function candidateFromPatch(input: {
  id: string;
  source: MetadataCandidateSource;
  confidence: MetadataCandidate["confidence"];
  patch: LibraryMetadataPatch;
  provenance: MetadataCandidate["provenance"];
}): MetadataCandidate | null {
  const patch = normalizedPatch(input.patch);
  if (!patch || Object.keys(patch).length === 0) return null;
  return {
    schemaVersion: METADATA_CANDIDATE_SCHEMA_VERSION,
    id: input.id,
    source: input.source,
    confidence: input.confidence,
    patch,
    provenance: input.provenance,
  };
}

export function parseFilenameMetadataCandidates(input: {
  sourcePath: string;
  patterns?: readonly string[];
  generatedAt: string;
  itemId?: string;
}): MetadataCandidate[] {
  const customPatterns = input.patterns ?? [];
  if (customPatterns.some((pattern) => pattern.length === 0 || pattern.length > MAX_FILENAME_PATTERN_LENGTH)) {
    throw new TypeError("invalid-pattern");
  }
  const stem = basename(input.sourcePath, extname(input.sourcePath));
  const candidates: MetadataCandidate[] = [];
  for (const pattern of [...customPatterns, ...BUILTIN_PATTERNS]) {
    let match: RegExpMatchArray | null;
    try {
      match = stem.match(new RegExp(pattern, "u"));
    } catch {
      throw new TypeError("invalid-pattern");
    }
    const groups = match?.groups;
    if (!groups) continue;
    const patch = normalizedPatch({
      title: cleanText(groups.title),
      author: cleanText(groups.author),
      authors: cleanText(groups.author) ? [{ name: cleanText(groups.author)! }] : undefined,
      series: cleanText(groups.series),
      seriesIndex: groups.seriesIndex === undefined ? undefined : Number(groups.seriesIndex),
    });
    if (!patch || !patch.title) continue;
    candidates.push({
      schemaVersion: METADATA_CANDIDATE_SCHEMA_VERSION,
      id: `filename:${candidates.length + 1}`,
      source: "filename",
      confidence: pattern === customPatterns[0] ? "high" : "medium",
      patch,
      provenance: { generatedAt: input.generatedAt, itemId: input.itemId, sourcePath: input.sourcePath, pattern },
    });
    if (candidates.length >= MAX_METADATA_CANDIDATES) break;
  }
  return candidates;
}

export function parseMetadataCandidateJson(json: string): MetadataCandidate | null {
  const value = JSON.parse(json) as MetadataCandidate;
  if (value.schemaVersion !== METADATA_CANDIDATE_SCHEMA_VERSION) return null;
  if (!["filename", "embedded", "online", "manual"].includes(value.source)) return null;
  return candidateFromPatch({
    id: String(value.id || ""),
    source: value.source,
    confidence: value.confidence,
    patch: value.patch,
    provenance: value.provenance,
  });
}
