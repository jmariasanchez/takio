import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const ARTIFACT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_COVER_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MANIFEST_KEYS = [
  "artifactId",
  "bytes",
  "candidateId",
  "createdAt",
  "expiresAt",
  "extension",
  "itemId",
  "mediaType",
  "provenance",
  "schemaVersion",
  "sha256",
  "source",
] as const;

type Manifest = Readonly<{
  schemaVersion: number;
  artifactId: string;
  itemId: string;
  candidateId: string;
  source: string;
  provenance: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  extension: string;
  createdAt: string;
  expiresAt: string;
}>;

const coverTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return null;
    const bytes = await readFile(path);
    return bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

function decodeManifest(bytes: Buffer, artifactId: string): Manifest | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== [...MANIFEST_KEYS].sort()[index])) return null;
    if (
      value.schemaVersion !== 1 ||
      value.artifactId !== artifactId ||
      typeof value.itemId !== "string" || value.itemId.length === 0 ||
      typeof value.candidateId !== "string" || value.candidateId.length === 0 ||
      typeof value.source !== "string" || value.source.length === 0 ||
      typeof value.provenance !== "string" || value.provenance.length === 0 ||
      typeof value.sha256 !== "string" || !SHA256.test(value.sha256) ||
      typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_COVER_BYTES ||
      typeof value.mediaType !== "string" || coverTypes.get(value.mediaType) !== value.extension ||
      typeof value.extension !== "string" ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()
    ) return null;
    return value as Manifest;
  } catch {
    return null;
  }
}

export function candidateCoverUrl(artifactId: string): string | null {
  return ARTIFACT_ID.test(artifactId) ? `takio-cover://candidate/${artifactId}` : null;
}

export async function candidateCoverResponse(requestUrl: string, libraryRoot: string): Promise<Response> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return notFound();
  }
  const artifactId = url.pathname.slice(1);
  if (
    url.protocol !== "takio-cover:" || url.hostname !== "candidate" || url.port !== "" ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    url.pathname !== `/${artifactId}` || !ARTIFACT_ID.test(artifactId)
  ) return notFound();

  const root = join(libraryRoot, "candidate-covers");
  const rootMetadata = await lstat(root).catch(() => null);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) return notFound();
  const manifestBytes = await readRegular(join(root, `${artifactId}.json`), MAX_MANIFEST_BYTES);
  if (!manifestBytes) return notFound();
  const manifest = decodeManifest(manifestBytes, artifactId);
  if (!manifest) return notFound();
  const cover = await readRegular(join(root, `${artifactId}.bin`), MAX_COVER_BYTES);
  if (!cover || cover.length !== manifest.bytes) return notFound();
  if (createHash("sha256").update(cover).digest("hex") !== manifest.sha256) return notFound();

  return new Response(new Uint8Array(cover), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": manifest.mediaType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
