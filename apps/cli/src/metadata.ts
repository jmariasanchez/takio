import type { FormatId, LibraryItem } from "@takio/core";
import { libraryMetadataPatchSchema, type LibraryMetadataPatch } from "@takio/library-contract";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MACOS_BUNDLE_BINARY = "/Applications/calibre.app/Contents/MacOS/ebook-meta";
const FETCH_MACOS_BUNDLE_BINARY = "/Applications/calibre.app/Contents/MacOS/fetch-ebook-metadata";
const MAX_OPF_BYTES = 2 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

export const EMBEDDABLE_METADATA_FORMATS: readonly FormatId[] = [
  "epub",
  "pdf",
  "mobi",
  "azw3",
  "docx",
];

const METADATA_ERROR_CODES = [
  "invalid-arguments",
  "backend-unavailable",
  "source-unavailable",
  "metadata-extraction-failed",
  "metadata-timeout",
  "metadata-invalid",
  "metadata-write-unsupported",
  "metadata-write-failed",
  "metadata-fetch-failed",
  "cover-output-exists",
  "cover-write-failed",
] as const;

export type MetadataErrorCode = (typeof METADATA_ERROR_CODES)[number];

export class MetadataError extends Error {
  constructor(readonly code: MetadataErrorCode) {
    super(code);
    this.name = "MetadataError";
  }
}

export type EbookMetaDiscovery =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "invalid-arguments" | "backend-unavailable" };

export type ExtractedCover = Readonly<{
  bytes: Uint8Array;
  extension: ".gif" | ".jpg" | ".png" | ".webp";
  mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
}>;

export type ExtractedEbookMetadata = Readonly<{
  sourcePath: string;
  metadata: LibraryMetadataPatch;
  cover: ExtractedCover | null;
}>;

type ExtractEbookMetadataOptions = Readonly<{
  backendPath: string;
  sourcePath: string;
  timeoutMs: number;
}>;

type MaterializeEbookMetadataOptions = Readonly<{
  backendPath: string;
  artifactPath: string;
  format: FormatId;
  item: LibraryItem;
  timeoutMs: number;
}>;

type FetchOnlineMetadataOptions = Readonly<{
  backendPath: string;
  title?: string;
  authors?: readonly string[];
  identifiers?: Readonly<Record<string, string>>;
  coverOutputPath?: string;
  timeoutMs: number;
}>;

export type MaterializedEbookArtifact = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type FetchedOnlineMetadata = Readonly<{
  metadata: LibraryMetadataPatch;
  cover: null | Readonly<{
    path: string;
    bytes: number;
    sha256: string;
    extension: ExtractedCover["extension"];
    mediaType: ExtractedCover["mediaType"];
  }>;
}>;

async function executable(path: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await stat(canonicalPath)).isFile()) {
      return null;
    }
    await access(canonicalPath, constants.X_OK);
    return canonicalPath;
  } catch {
    return null;
  }
}

async function discoverCalibreExecutable(
  overrideName: "TAKIO_EBOOK_META" | "TAKIO_FETCH_EBOOK_METADATA",
  binaryName: "ebook-meta" | "fetch-ebook-metadata",
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  macosBundleBinary: string,
): Promise<EbookMetaDiscovery> {
  if (Object.hasOwn(env, overrideName)) {
    const override = env[overrideName];
    if (override === "" || override === undefined) {
      return { ok: false, code: "invalid-arguments" };
    }
    const path = await executable(override);
    return path
      ? { ok: true, path }
      : { ok: false, code: "backend-unavailable" };
  }

  let fromPath: string | null = null;
  try {
    fromPath = Bun.which(binaryName, { PATH: env.PATH });
  } catch {
    // An unusable search path is the same as a backend discovery miss.
  }
  if (fromPath) {
    const path = await executable(fromPath);
    if (path) {
      return { ok: true, path };
    }
  }

  if (platform === "darwin") {
    const path = await executable(macosBundleBinary);
    if (path) {
      return { ok: true, path };
    }
  }

  return { ok: false, code: "backend-unavailable" };
}

export function discoverEbookMeta(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  macosBundleBinary: string = MACOS_BUNDLE_BINARY,
): Promise<EbookMetaDiscovery> {
  return discoverCalibreExecutable(
    "TAKIO_EBOOK_META",
    "ebook-meta",
    env,
    platform,
    macosBundleBinary,
  );
}

export function discoverFetchEbookMetadata(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  macosBundleBinary: string = FETCH_MACOS_BUNDLE_BINARY,
): Promise<EbookMetaDiscovery> {
  return discoverCalibreExecutable(
    "TAKIO_FETCH_EBOOK_METADATA",
    "fetch-ebook-metadata",
    env,
    platform,
    macosBundleBinary,
  );
}

function childEnvironment(workspace: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment.TMPDIR = workspace;
  environment.TMP = workspace;
  environment.TEMP = workspace;
  return environment;
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of file.readableWebStream()) {
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function metadataArguments(item: LibraryItem): string[] {
  const authors = item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []);
  const arguments_ = [`--title=${item.title}`];
  if (authors.length > 0) arguments_.push(`--authors=${authors.join(" & ")}`);
  if (item.authors?.some(({ sortName }) => sortName)) {
    arguments_.push(
      `--author-sort=${item.authors.map(({ name, sortName }) => sortName ?? name).join(" & ")}`,
    );
  }
  if (item.description) arguments_.push(`--comments=${item.description}`);
  if (item.publisher) arguments_.push(`--publisher=${item.publisher}`);
  if (item.series) arguments_.push(`--series=${item.series}`);
  if (item.seriesIndex !== undefined) arguments_.push(`--index=${item.seriesIndex}`);
  if (item.rating !== undefined && item.rating > 0) arguments_.push(`--rating=${item.rating / 2}`);
  if (item.languages?.[0]) arguments_.push(`--language=${item.languages[0]}`);
  if (item.publishedDate) arguments_.push(`--date=${item.publishedDate}`);
  if (item.tags.length > 0) arguments_.push(`--tags=${item.tags.join(", ")}`);
  for (const [kind, value] of Object.entries(item.identifiers ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    arguments_.push(`--identifier=${kind}:${value}`);
  }
  if (item.coverPath) arguments_.push(`--cover=${item.coverPath}`);
  return arguments_;
}

function text(value: unknown): string | undefined {
  const candidate =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : value && typeof value === "object" && "#text" in value
        ? String((value as { "#text": unknown })["#text"])
        : "";
  const normalized = candidate.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function values(value: unknown): readonly unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function attribute(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object" || !(name in value)) {
    return undefined;
  }
  return text((value as Record<string, unknown>)[name]);
}

function uniqueTexts(input: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const normalized = text(value);
    const key = normalized?.toLowerCase();
    if (normalized && key && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function validPatchField<K extends keyof LibraryMetadataPatch>(
  key: K,
  value: NonNullable<LibraryMetadataPatch[K]>,
): LibraryMetadataPatch[K] | undefined {
  const parsed = libraryMetadataPatchSchema.safeParse({ tags: [], [key]: value });
  return parsed.success ? parsed.data[key] : undefined;
}

function metaContent(entries: readonly unknown[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const entry of entries) {
    if (attribute(entry, "name")?.toLowerCase() === wanted) {
      return attribute(entry, "content");
    }
  }
  return undefined;
}

export function parseEbookMetadataOpf(opf: string): LibraryMetadataPatch {
  if (XMLValidator.validate(opf) !== true) {
    throw new MetadataError("metadata-invalid");
  }
  let document: unknown;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      removeNSPrefix: true,
      processEntities: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(opf);
  } catch {
    throw new MetadataError("metadata-invalid");
  }

  const packageNode =
    document && typeof document === "object"
      ? (document as Record<string, unknown>).package
      : undefined;
  const metadataNode =
    packageNode && typeof packageNode === "object"
      ? (packageNode as Record<string, unknown>).metadata
      : undefined;
  if (!metadataNode || typeof metadataNode !== "object") {
    throw new MetadataError("metadata-invalid");
  }
  const metadata = metadataNode as Record<string, unknown>;
  const patch: Record<string, unknown> = { tags: uniqueTexts(values(metadata.subject)) };

  const title = text(values(metadata.title)[0]);
  if (title) {
    patch.title = title;
  }

  const authors = values(metadata.creator).flatMap((creator) => {
    const role = attribute(creator, "role")?.toLowerCase();
    const name = text(creator);
    if (!name || (role && role !== "aut")) {
      return [];
    }
    const sortName = attribute(creator, "file-as");
    return [{ name, ...(sortName ? { sortName } : {}) }];
  });
  const validAuthors = validPatchField("authors", authors);
  if (validAuthors) {
    patch.authors = validAuthors;
  }

  for (const [key, source] of [
    ["publisher", metadata.publisher],
    ["description", metadata.description],
  ] as const) {
    const value = text(values(source)[0]);
    if (value) {
      patch[key] = value;
    }
  }

  const languages = uniqueTexts(values(metadata.language))
    .map((language) => language.replaceAll("_", "-"))
    .filter((language) => validPatchField("languages", [language]) !== undefined);
  const validLanguages = validPatchField("languages", languages);
  if (validLanguages) {
    patch.languages = validLanguages;
  }

  const identifiers: Record<string, string> = {};
  for (const identifier of values(metadata.identifier)) {
    const scheme = attribute(identifier, "scheme")?.toLowerCase();
    const value = text(identifier);
    if (scheme && value && identifiers[scheme] === undefined) {
      identifiers[scheme] = value;
    }
  }
  const validIdentifiers = validPatchField("identifiers", identifiers);
  if (validIdentifiers && Object.keys(validIdentifiers).length > 0) {
    patch.identifiers = validIdentifiers;
  }

  const rawDate = text(values(metadata.date)[0]);
  const date = rawDate?.match(/^\d{4}(?:-\d{2}(?:-\d{2})?)?/)?.[0];
  const validDate = date ? validPatchField("publishedDate", date) : undefined;
  if (validDate) {
    patch.publishedDate = validDate;
  }

  const meta = values(metadata.meta);
  const series = metaContent(meta, "calibre:series");
  if (series) {
    patch.series = series;
  }
  const seriesIndex = Number(metaContent(meta, "calibre:series_index"));
  if (Number.isFinite(seriesIndex)) {
    patch.seriesIndex = seriesIndex;
  }
  const rating = Number(metaContent(meta, "calibre:rating"));
  if (Number.isFinite(rating) && rating >= 0 && rating <= 10) {
    patch.rating = rating;
  }

  const parsed = libraryMetadataPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new MetadataError("metadata-invalid");
  }
  return parsed.data;
}

function detectedCover(bytes: Uint8Array): ExtractedCover | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, extension: ".jpg", mediaType: "image/jpeg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { bytes, extension: ".png", mediaType: "image/png" };
  }
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (bytes.length >= 6 && (header.startsWith("GIF87a") || header.startsWith("GIF89a"))) {
    return { bytes, extension: ".gif", mediaType: "image/gif" };
  }
  if (bytes.length >= 12 && header.startsWith("RIFF") && header.slice(8) === "WEBP") {
    return { bytes, extension: ".webp", mediaType: "image/webp" };
  }
  return null;
}

async function boundedFile(path: string, maximumBytes: number): Promise<Uint8Array | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumBytes) {
      return null;
    }
    const bytes = await readFile(path);
    return bytes.length === metadata.size ? bytes : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function boundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  child: Bun.Subprocess,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded-output failure remains authoritative.
      }
      throw new MetadataError("metadata-invalid");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function publishCover(
  requestedPath: string,
  cover: ExtractedCover,
): Promise<NonNullable<FetchedOnlineMetadata["cover"]>> {
  if (requestedPath.trim() === "") throw new MetadataError("invalid-arguments");

  let destinationPath: string;
  try {
    const parent = await realpath(dirname(resolve(requestedPath)));
    if (!(await stat(parent)).isDirectory()) throw new Error("not a directory");
    await access(parent, constants.W_OK);
    destinationPath = join(parent, basename(resolve(requestedPath)));
  } catch {
    throw new MetadataError("invalid-arguments");
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    file = await open(destinationPath, "wx", 0o600);
    created = true;
    await file.writeFile(cover.bytes);
    await file.sync();
    await file.close();
    file = undefined;

    const expectedSha256 = createHash("sha256").update(cover.bytes).digest("hex");
    const artifact = await hashFile(destinationPath);
    if (artifact.bytes !== cover.bytes.byteLength || artifact.sha256 !== expectedSha256) {
      throw new MetadataError("cover-write-failed");
    }
    return {
      path: await realpath(destinationPath),
      ...artifact,
      extension: cover.extension,
      mediaType: cover.mediaType,
    };
  } catch (error) {
    await file?.close().catch(() => {});
    if (created) await rm(destinationPath, { force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MetadataError("cover-output-exists");
    }
    if (error instanceof MetadataError) throw error;
    throw new MetadataError("cover-write-failed");
  }
}

export async function materializeEbookMetadata({
  backendPath,
  artifactPath,
  format,
  item,
  timeoutMs,
}: MaterializeEbookMetadataOptions): Promise<MaterializedEbookArtifact> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new MetadataError("invalid-arguments");
  }
  if (!EMBEDDABLE_METADATA_FORMATS.includes(format)) {
    throw new MetadataError("metadata-write-unsupported");
  }

  const canonicalBackend = await executable(backendPath);
  if (!canonicalBackend) {
    throw new MetadataError("backend-unavailable");
  }

  let canonicalArtifact: string;
  try {
    const requested = resolve(artifactPath);
    const requestedMetadata = await lstat(requested);
    if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink() || requestedMetadata.size === 0) {
      throw new Error("artifact is not a nonempty regular file");
    }
    canonicalArtifact = await realpath(requested);
    await access(canonicalArtifact, constants.R_OK | constants.W_OK);
    if (item.coverPath) {
      const cover = await lstat(item.coverPath);
      if (!cover.isFile() || cover.isSymbolicLink() || cover.size === 0) {
        throw new Error("cover is not a nonempty regular file");
      }
      await access(item.coverPath, constants.R_OK);
    }
  } catch {
    throw new MetadataError("source-unavailable");
  }

  let workspace: string | undefined;
  let child: Bun.Subprocess | undefined;
  let timedOut = false;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-metadata-write-"));
    await chmod(workspace, 0o700);
    try {
      child = Bun.spawn(
        [canonicalBackend, canonicalArtifact, ...metadataArguments(item)],
        {
          cwd: workspace,
          env: childEnvironment(workspace),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    } catch {
      throw new MetadataError("backend-unavailable");
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // The awaited process status remains authoritative.
      }
    }, timeoutMs);
    timer.unref();
    const exitCode = await child.exited;
    clearTimeout(timer);
    if (timedOut) throw new MetadataError("metadata-timeout");
    if (exitCode !== 0) throw new MetadataError("metadata-write-failed");

    const artifact = await hashFile(canonicalArtifact);
    if (artifact.bytes === 0) throw new MetadataError("metadata-write-failed");
    return { path: canonicalArtifact, ...artifact };
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    throw new MetadataError("metadata-write-failed");
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        // Cleanup remains best-effort after the write result is known.
      }
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function fetchOnlineMetadata({
  backendPath,
  title,
  authors = [],
  identifiers = {},
  coverOutputPath,
  timeoutMs,
}: FetchOnlineMetadataOptions): Promise<FetchedOnlineMetadata> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new MetadataError("invalid-arguments");
  }

  const normalizedTitle = title?.trim();
  const normalizedAuthors = authors.map((author) => author.trim());
  const normalizedIdentifiers: Record<string, string> = {};
  for (const [rawKind, rawValue] of Object.entries(identifiers)) {
    const kind = rawKind.trim().toLowerCase();
    const value = rawValue.trim();
    if (!kind || kind.includes(":") || !value || normalizedIdentifiers[kind] !== undefined) {
      throw new MetadataError("invalid-arguments");
    }
    normalizedIdentifiers[kind] = value;
  }
  if (
    (title !== undefined && !normalizedTitle) ||
    normalizedAuthors.some((author) => !author) ||
    (coverOutputPath !== undefined && coverOutputPath.trim() === "") ||
    (!normalizedTitle && normalizedAuthors.length === 0 && !normalizedIdentifiers.isbn)
  ) {
    throw new MetadataError("invalid-arguments");
  }

  const canonicalBackend = await executable(backendPath);
  if (!canonicalBackend) throw new MetadataError("backend-unavailable");

  let workspace: string | undefined;
  let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-metadata-fetch-"));
    await chmod(workspace, 0o700);
    const coverPath = join(workspace, "cover");
    const arguments_ = [canonicalBackend, "--opf"];
    if (normalizedTitle) arguments_.push(`--title=${normalizedTitle}`);
    if (normalizedAuthors.length > 0) {
      arguments_.push(`--authors=${normalizedAuthors.join(" & ")}`);
    }
    if (normalizedIdentifiers.isbn) {
      arguments_.push(`--isbn=${normalizedIdentifiers.isbn}`);
    }
    for (const [kind, value] of Object.entries(normalizedIdentifiers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (kind !== "isbn") arguments_.push(`--identifier=${kind}:${value}`);
    }
    if (coverOutputPath !== undefined) arguments_.push(`--cover=${coverPath}`);
    arguments_.push(`--timeout=${Math.ceil(timeoutMs / 1000)}`);

    try {
      child = Bun.spawn(arguments_, {
        cwd: workspace,
        env: childEnvironment(workspace),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      throw new MetadataError("backend-unavailable");
    }

    const output = boundedStream(child.stdout, MAX_OPF_BYTES, child);
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // The awaited process status remains authoritative.
      }
    }, timeoutMs);
    timer.unref();
    const [exitCode, opfBytes] = await Promise.all([child.exited, output]);
    clearTimeout(timer);
    timer = undefined;
    if (timedOut) throw new MetadataError("metadata-timeout");
    if (exitCode !== 0) throw new MetadataError("metadata-fetch-failed");
    if (opfBytes.byteLength === 0) throw new MetadataError("metadata-invalid");

    const metadata = parseEbookMetadataOpf(new TextDecoder().decode(opfBytes));
    const coverBytes = coverOutputPath
      ? await boundedFile(coverPath, MAX_COVER_BYTES)
      : null;
    const cover = coverBytes ? detectedCover(coverBytes) : null;
    return {
      metadata,
      cover: cover && coverOutputPath ? await publishCover(coverOutputPath, cover) : null,
    };
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    throw new MetadataError("metadata-fetch-failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        // Cleanup remains best-effort after the fetch result is known.
      }
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function extractEbookMetadata({
  backendPath,
  sourcePath,
  timeoutMs,
}: ExtractEbookMetadataOptions): Promise<ExtractedEbookMetadata> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new MetadataError("invalid-arguments");
  }

  const canonicalBackend = await executable(backendPath);
  if (!canonicalBackend) {
    throw new MetadataError("backend-unavailable");
  }

  let canonicalSource: string;
  try {
    canonicalSource = await realpath(resolve(sourcePath));
    const source = await stat(canonicalSource);
    if (!source.isFile() || source.size === 0) {
      throw new Error("source is not a nonempty file");
    }
    await access(canonicalSource, constants.R_OK);
  } catch {
    throw new MetadataError("source-unavailable");
  }

  let workspace: string | undefined;
  let child: Bun.Subprocess | undefined;
  let timedOut = false;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-metadata-"));
    await chmod(workspace, 0o700);
    const opfPath = join(workspace, "metadata.opf");
    const coverPath = join(workspace, "cover");

    try {
      child = Bun.spawn(
        [
          canonicalBackend,
          canonicalSource,
          `--to-opf=${opfPath}`,
          `--get-cover=${coverPath}`,
          "--disallow-rendered-cover",
        ],
        {
          cwd: workspace,
          env: childEnvironment(workspace),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    } catch {
      throw new MetadataError("backend-unavailable");
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // The awaited process status remains authoritative.
      }
    }, timeoutMs);
    timer.unref();
    const exitCode = await child.exited;
    clearTimeout(timer);
    if (timedOut) {
      throw new MetadataError("metadata-timeout");
    }
    if (exitCode !== 0) {
      throw new MetadataError("metadata-extraction-failed");
    }

    const opfBytes = await boundedFile(opfPath, MAX_OPF_BYTES);
    if (!opfBytes) {
      throw new MetadataError("metadata-invalid");
    }
    const metadata = parseEbookMetadataOpf(new TextDecoder().decode(opfBytes));
    const coverBytes = await boundedFile(coverPath, MAX_COVER_BYTES);
    return {
      sourcePath: canonicalSource,
      metadata,
      cover: coverBytes ? detectedCover(coverBytes) : null,
    };
  } catch (error) {
    if (error instanceof MetadataError) {
      throw error;
    }
    throw new MetadataError("metadata-invalid");
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        // Cleanup remains best-effort after the extraction result is known.
      }
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
