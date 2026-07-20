import { libraryMetadataPatchSchema, type LibraryMetadataPatch } from "@takio/library-contract";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MACOS_BUNDLE_BINARY = "/Applications/calibre.app/Contents/MacOS/ebook-meta";
const MAX_OPF_BYTES = 2 * 1024 * 1024;
const MAX_COVER_BYTES = 32 * 1024 * 1024;

const METADATA_ERROR_CODES = [
  "invalid-arguments",
  "backend-unavailable",
  "source-unavailable",
  "metadata-extraction-failed",
  "metadata-timeout",
  "metadata-invalid",
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

export async function discoverEbookMeta(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  macosBundleBinary: string = MACOS_BUNDLE_BINARY,
): Promise<EbookMetaDiscovery> {
  if (Object.hasOwn(env, "TAKIO_EBOOK_META")) {
    const override = env.TAKIO_EBOOK_META;
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
    fromPath = Bun.which("ebook-meta", { PATH: env.PATH });
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

function parseMetadata(opf: string): LibraryMetadataPatch {
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
    const metadata = parseMetadata(new TextDecoder().decode(opfBytes));
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
