import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

import {
  FORMAT_IDS,
  libraryItemSchema,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import {
  BunSqliteLibraryStore,
  verifyLibraryIntegrity,
  type LibraryIntegrityReport,
} from "@takio/library-store-bun";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { parseEbookMetadataOpf } from "./metadata.js";

const PORTABLE_FORMAT = "takio-portable-library";
export const PORTABLE_LIBRARY_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

type PortableArtifact = Readonly<{ path: string; bytes: number; sha256: string }>;
type PortableBook = Readonly<{ directory: string; artifacts: readonly PortableArtifact[] }>;
type PortableManifest = Readonly<{
  format: typeof PORTABLE_FORMAT;
  version: typeof PORTABLE_LIBRARY_VERSION;
  books: readonly PortableBook[];
}>;

export type PortableLibraryResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly path: string;
        readonly items: number;
        readonly formats: number;
        readonly covers: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "invalid-arguments"
          | "destination-exists"
          | "source-invalid"
          | "storage-unavailable";
      };
    };

export type PortableRebuildResult =
  | {
      readonly ok: true;
      readonly value: { readonly path: string; readonly report: LibraryIntegrityReport };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "invalid-arguments"
          | "destination-exists"
          | "source-invalid"
          | "storage-unavailable";
      };
    };

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function values(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function attribute(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === "string" ? candidate : undefined;
}

function content(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)["#text"];
  return typeof candidate === "string" ? candidate.trim() || undefined : undefined;
}

function metaContent(entries: readonly unknown[], name: string): string | undefined {
  const entry = entries.find((candidate) => attribute(candidate, "name") === name);
  return attribute(entry, "content");
}

function mediaType(format: FormatId): string {
  return {
    kepub: "application/epub+zip",
    epub: "application/epub+zip",
    pdf: "application/pdf",
    mobi: "application/x-mobipocket-ebook",
    azw3: "application/vnd.amazon.mobi8-ebook",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    html: "text/html",
    txt: "text/plain",
    cbz: "application/vnd.comicbook+zip",
  }[format];
}

function portableOpf(item: LibraryItem, coverName?: string): string {
  const authors = item.authors ?? (item.author ? [{ name: item.author }] : []);
  const metadata = [
    `    <dc:title>${xml(item.title)}</dc:title>`,
    ...authors.map((author) =>
      `    <dc:creator opf:role="aut"${author.sortName ? ` opf:file-as="${xml(author.sortName)}"` : ""}>${xml(author.name)}</dc:creator>`,
    ),
    ...(item.publisher ? [`    <dc:publisher>${xml(item.publisher)}</dc:publisher>`] : []),
    ...(item.description ? [`    <dc:description>${xml(item.description)}</dc:description>`] : []),
    ...(item.languages ?? []).map((language) => `    <dc:language>${xml(language)}</dc:language>`),
    ...item.tags.map((tag) => `    <dc:subject>${xml(tag)}</dc:subject>`),
    ...(item.publishedDate ? [`    <dc:date>${xml(item.publishedDate)}</dc:date>`] : []),
    `    <dc:identifier id="takio-id" opf:scheme="takio">${xml(item.id)}</dc:identifier>`,
    ...Object.entries(item.identifiers ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scheme, identifier]) =>
        `    <dc:identifier opf:scheme="${xml(scheme)}">${xml(identifier)}</dc:identifier>`,
      ),
    ...(item.series ? [`    <meta name="calibre:series" content="${xml(item.series)}"/>`] : []),
    ...(item.seriesIndex !== undefined
      ? [`    <meta name="calibre:series_index" content="${item.seriesIndex}"/>`]
      : []),
    ...(item.rating !== undefined
      ? [`    <meta name="calibre:rating" content="${item.rating}"/>`]
      : []),
    ...Object.entries(item.customMetadata ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) =>
        `    <meta name="takio:custom:${xml(name)}" content="${xml(value)}"/>`,
      ),
    `    <meta name="takio:added_at" content="${xml(item.addedAt)}"/>`,
    ...(item.updatedAt
      ? [`    <meta name="takio:updated_at" content="${xml(item.updatedAt)}"/>`]
      : []),
    `    <meta name="takio:format_order" content="${item.formats.map(({ format }) => format).join(",")}"/>`,
    ...(coverName ? ["    <meta name=\"cover\" content=\"cover-image\"/>"] : []),
  ];
  const manifest = [
    ...item.formats.map(({ format }) =>
      `    <item id="format-${format}" href="book.${format}" media-type="${mediaType(format)}"/>`,
    ),
    ...(coverName
      ? [`    <item id="cover-image" href="${xml(coverName)}" media-type="image/${coverName.endsWith(".png") ? "png" : "jpeg"}"/>`]
      : []),
  ];
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="takio-id" version="2.0">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    ...metadata,
    "  </metadata>",
    "  <manifest>",
    ...manifest,
    "  </manifest>",
    "</package>",
    "",
  ].join("\n");
}

function safeBookDirectory(item: LibraryItem): string {
  const title = item.title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48) || "Book";
  const idHash = createHash("sha256").update(item.id).digest("hex");
  return `${title} [${idHash}]`;
}

async function fingerprint(path: string, relativePath: string): Promise<PortableArtifact> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = await file.stat();
    if (!entry.isFile() || entry.size < 1) {
      throw new TypeError("Portable artifacts must be nonempty regular files.");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.readableWebStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    return { path: relativePath, bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

function isInside(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${sep}`);
}

function artifactPath(root: string, directory: string, leaf: string): string {
  if (
    directory.length < 1 || directory.length > 128 || directory === "." || directory === ".." ||
    directory.includes("/") || directory.includes("\\") ||
    !/^(?:metadata\.opf|book\.(?:kepub|epub|pdf|mobi|azw3|docx|html|txt|cbz)|cover\.(?:jpg|jpeg|png))$/.test(leaf)
  ) {
    throw new TypeError("Invalid portable path.");
  }
  const booksRoot = resolve(root, "books");
  const path = resolve(booksRoot, directory, leaf);
  if (!isInside(booksRoot, path)) throw new TypeError("Invalid portable path.");
  return path;
}

function validArtifact(value: unknown): value is PortableArtifact {
  return typeof value === "object" && value !== null &&
    typeof (value as PortableArtifact).path === "string" &&
    Number.isSafeInteger((value as PortableArtifact).bytes) &&
    (value as PortableArtifact).bytes > 0 &&
    /^[0-9a-f]{64}$/.test((value as PortableArtifact).sha256);
}

function validBook(value: unknown): value is PortableBook {
  if (!value || typeof value !== "object") return false;
  const book = value as { directory?: unknown; artifacts?: unknown };
  return typeof book.directory === "string" &&
    Array.isArray(book.artifacts) && book.artifacts.length >= 2 &&
    book.artifacts.every(validArtifact) &&
    new Set(book.artifacts.map((artifact) => artifact.path)).size === book.artifacts.length;
}

async function copyArtifact(
  source: string,
  destination: string,
  relativePath: string,
): Promise<PortableArtifact> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const entry = await input.stat();
    if (!entry.isFile() || entry.size < 1) {
      throw new TypeError("Portable sources must be nonempty regular files.");
    }
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      await output.write(buffer, 0, read.bytesRead);
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
    await output.sync();
    return { path: relativePath, bytes, sha256: hash.digest("hex") };
  } finally {
    await output?.close();
    await input.close();
  }
}

async function readManifest(root: string): Promise<PortableManifest> {
  const manifestPath = join(root, "manifest.json");
  const manifestEntry = await lstat(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink() || manifestEntry.size > MAX_MANIFEST_BYTES) {
    throw new TypeError("Invalid portable manifest.");
  }
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new TypeError("Invalid portable manifest.");
  const candidate = parsed as Partial<PortableManifest>;
  if (
    candidate.format !== PORTABLE_FORMAT || candidate.version !== PORTABLE_LIBRARY_VERSION ||
    !Array.isArray(candidate.books) ||
    !candidate.books.every(validBook) ||
    new Set(candidate.books.map(({ directory }) => directory)).size !== candidate.books.length
  ) {
    throw new TypeError("Invalid portable manifest.");
  }
  for (const book of candidate.books) {
    if (!book.artifacts.some(({ path }) => path === "metadata.opf")) {
      throw new TypeError("Portable metadata is required.");
    }
    const directoryPath = resolve(root, "books", book.directory);
    const directoryEntry = await lstat(directoryPath);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new TypeError("Invalid portable book directory.");
    }
    for (const artifact of book.artifacts) {
      const path = artifactPath(root, book.directory, artifact.path);
      const actual = await fingerprint(path, artifact.path);
      if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
        throw new TypeError("Portable artifact changed.");
      }
    }
  }
  return candidate as PortableManifest;
}

type ParsedPortableBook = Readonly<{
  item: LibraryItem;
  formats: readonly Readonly<{ format: FormatId; path: string }>[];
  coverPath?: string;
}>;

async function parsePortableBook(root: string, book: PortableBook): Promise<ParsedPortableBook> {
  const opfPath = artifactPath(root, book.directory, "metadata.opf");
  const opf = await readFile(opfPath, "utf8");
  if (XMLValidator.validate(opf) !== true) throw new TypeError("Invalid OPF.");
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    processEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
  }).parse(opf) as Record<string, unknown>;
  const packageNode = document.package as Record<string, unknown> | undefined;
  const metadataNode = packageNode?.metadata as Record<string, unknown> | undefined;
  const manifestNode = packageNode?.manifest as Record<string, unknown> | undefined;
  if (!metadataNode || !manifestNode) throw new TypeError("Invalid OPF.");
  const identifiers = values(metadataNode.identifier);
  const id = content(identifiers.find((identifier) => attribute(identifier, "scheme") === "takio"));
  const meta = values(metadataNode.meta);
  const addedAt = metaContent(meta, "takio:added_at");
  const updatedAt = metaContent(meta, "takio:updated_at");
  const formatOrder = metaContent(meta, "takio:format_order")?.split(",") ?? [];
  const customMetadata: Record<string, string> = {};
  for (const entry of meta) {
    const name = attribute(entry, "name");
    if (!name?.startsWith("takio:custom:")) continue;
    const key = name.slice("takio:custom:".length);
    const value = attribute(entry, "content");
    if (!key || value === undefined || key in customMetadata) {
      throw new TypeError("Invalid portable custom metadata.");
    }
    customMetadata[key] = value;
  }
  if (!id || !addedAt || formatOrder.length < 1 || new Set(formatOrder).size !== formatOrder.length) {
    throw new TypeError("Incomplete portable metadata.");
  }
  const formats = formatOrder.map((format) => {
    if (!FORMAT_IDS.includes(format as FormatId)) throw new TypeError("Unsupported portable format.");
    const leaf = `book.${format}`;
    const manifestItem = values(manifestNode.item).find(
      (item) => attribute(item, "id") === `format-${format}`,
    );
    if (attribute(manifestItem, "href") !== leaf || !book.artifacts.some(({ path }) => path === leaf)) {
      throw new TypeError("Missing portable format.");
    }
    return { format: format as FormatId, path: artifactPath(root, book.directory, leaf) };
  });
  const patch = parseEbookMetadataOpf(opf);
  const portableIdentifiers = { ...(patch.identifiers ?? {}) };
  delete portableIdentifiers.takio;
  const primary = formats[0]!;
  const parsedItem = libraryItemSchema.safeParse({
    id,
    title: patch.title,
    sourcePath: primary.path,
    format: primary.format,
    addedAt,
    formats: [{
      sourcePath: primary.path,
      format: primary.format,
      addedAt,
      provenance: "referenced",
    }],
    ...(patch.authors ? { authors: patch.authors, author: patch.authors[0]?.name } : {}),
    ...(patch.series ? { series: patch.series } : {}),
    ...(patch.seriesIndex !== undefined ? { seriesIndex: patch.seriesIndex } : {}),
    ...(patch.publisher ? { publisher: patch.publisher } : {}),
    ...(patch.languages ? { languages: patch.languages } : {}),
    ...(Object.keys(portableIdentifiers).length > 0 ? { identifiers: portableIdentifiers } : {}),
    ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
    ...(patch.publishedDate ? { publishedDate: patch.publishedDate } : {}),
    ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
    ...(patch.description ? { description: patch.description } : {}),
    tags: patch.tags ?? [],
    ...(updatedAt ? { updatedAt } : {}),
  });
  if (!parsedItem.success) throw new TypeError("Invalid portable metadata.");
  const coverItem = values(manifestNode.item).find((item) => attribute(item, "id") === "cover-image");
  const coverLeaf = attribute(coverItem, "href");
  const coverPath = coverLeaf && book.artifacts.some(({ path }) => path === coverLeaf)
    ? artifactPath(root, book.directory, coverLeaf)
    : undefined;
  return { item: parsedItem.data, formats, ...(coverPath ? { coverPath } : {}) };
}

export async function exportPortableLibrary(
  store: BunSqliteLibraryStore,
  destinationPath: string,
): Promise<PortableLibraryResult> {
  if (destinationPath.trim() === "") return { ok: false, error: { code: "invalid-arguments" } };
  const destination = resolve(destinationPath);
  try {
    await lstat(destination);
    return { ok: false, error: { code: "destination-exists" } };
  } catch {}
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    const listed = await store.list({});
    if (!listed.ok) return { ok: false, error: { code: "storage-unavailable" } };
    await mkdir(join(temporary, "books"), { recursive: true, mode: 0o700 });
    await chmod(temporary, 0o700);
    const books: PortableBook[] = [];
    let formatCount = 0;
    let coverCount = 0;
    for (const item of listed.value) {
      const directory = safeBookDirectory(item);
      const bookRoot = join(temporary, "books", directory);
      await mkdir(bookRoot, { mode: 0o700 });
      let coverName: string | undefined;
      if (item.coverPath) {
        const extension = extname(item.coverPath).toLowerCase();
        if (![".jpg", ".jpeg", ".png"].includes(extension)) throw new TypeError("Invalid cover.");
        coverName = `cover${extension}`;
      }
      const artifacts: PortableArtifact[] = [];
      for (const format of item.formats) {
        const leaf = `book.${format.format}`;
        const path = join(bookRoot, leaf);
        artifacts.push(await copyArtifact(format.sourcePath, path, leaf));
        formatCount += 1;
      }
      if (item.coverPath && coverName) {
        const path = join(bookRoot, coverName);
        artifacts.push(await copyArtifact(item.coverPath, path, coverName));
        coverCount += 1;
      }
      const opfPath = join(bookRoot, "metadata.opf");
      await writeFile(opfPath, portableOpf(item, coverName), { mode: 0o600 });
      artifacts.push(await fingerprint(opfPath, "metadata.opf"));
      books.push({ directory, artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)) });
    }
    const manifest: PortableManifest = { format: PORTABLE_FORMAT, version: PORTABLE_LIBRARY_VERSION, books };
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    try {
      await lstat(destination);
      return { ok: false, error: { code: "destination-exists" } };
    } catch {}
    await rename(temporary, destination);
    return {
      ok: true,
      value: { path: destination, items: books.length, formats: formatCount, covers: coverCount },
    };
  } catch {
    return { ok: false, error: { code: "storage-unavailable" } };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function rebuildPortableLibrary(
  sourcePath: string,
  databasePath: string,
): Promise<PortableRebuildResult> {
  if (sourcePath.trim() === "" || databasePath.trim() === "") {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  const source = resolve(sourcePath);
  const database = resolve(databasePath);
  const destination = dirname(database);
  if (source === destination || isInside(source, destination)) {
    return { ok: false, error: { code: "invalid-arguments" } };
  }
  try {
    await lstat(destination);
    return { ok: false, error: { code: "destination-exists" } };
  } catch {}

  let manifest: PortableManifest;
  let books: ParsedPortableBook[];
  try {
    const sourceEntry = await lstat(source);
    if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) throw new TypeError("Invalid source.");
    manifest = await readManifest(source);
    books = [];
    for (const book of manifest.books) books.push(await parsePortableBook(source, book));
  } catch {
    return { ok: false, error: { code: "source-invalid" } };
  }

  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const temporaryDatabase = join(temporary, basename(database));
  const store = new BunSqliteLibraryStore(temporaryDatabase);
  try {
    await mkdir(temporary, { mode: 0o700 });
    const opened = await store.open({ config: {} });
    if (!opened.ok) throw new TypeError(opened.error.code);
    for (const book of books) {
      const added = await store.add({ item: book.item });
      if (!added.ok) throw new TypeError(added.error.code);
      const primary = added.value.formats[0]!;
      const replaced = await store.replaceFormat({
        id: book.item.id,
        format: primary.format,
        expectedCurrent: {
          sourcePath: primary.sourcePath,
          addedAt: primary.addedAt,
          provenance: primary.provenance,
        },
        source: { kind: "copy", path: book.formats[0]!.path },
      });
      if (!replaced.ok || !replaced.value.item) throw new TypeError("Primary format restore failed.");
      for (const format of book.formats.slice(1)) {
        const attached = await store.attachFormat({
          id: book.item.id,
          source: { kind: "copy", path: format.path },
        });
        if (!attached.ok || !attached.value) throw new TypeError("Format restore failed.");
      }
      if (book.coverPath) {
        const covered = await store.setCover({ id: book.item.id, sourcePath: book.coverPath });
        if (!covered.ok || !covered.value) throw new TypeError("Cover restore failed.");
      }
    }
    store.close();
    const report = verifyLibraryIntegrity(temporaryDatabase);
    if (!report.ok) throw new TypeError(report.error.code);
    try {
      await lstat(destination);
      return { ok: false, error: { code: "destination-exists" } };
    } catch {}
    await rename(temporary, destination);
    return { ok: true, value: { path: database, report: report.value } };
  } catch {
    return { ok: false, error: { code: "storage-unavailable" } };
  } finally {
    store.close();
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
