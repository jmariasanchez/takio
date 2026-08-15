import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const MIMETYPE = "application/epub+zip";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_COUNT = 20_000;

function preflightZip(input: Uint8Array): void {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const searchStart = Math.max(0, input.byteLength - 65_557);
  let end = -1;
  for (let offset = input.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new EpubTransformError("invalid-epub");

  const entryCount = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (entryCount > MAX_ENTRY_COUNT || centralOffset + centralSize > input.byteLength) {
    throw new EpubTransformError("archive-limit-exceeded");
  }

  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > input.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new EpubTransformError("invalid-epub");
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new EpubTransformError("archive-limit-exceeded");
    }
    totalBytes += uncompressed;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new EpubTransformError("archive-limit-exceeded");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset > centralOffset + centralSize) throw new EpubTransformError("invalid-epub");
}

export class EpubTransformError extends Error {
  constructor(readonly code: "invalid-epub" | "archive-limit-exceeded") {
    super(code);
    this.name = "EpubTransformError";
  }
}

export type KepubTransformReport = Readonly<{
  bytes: Uint8Array;
  contentDocuments: number;
  spans: number;
}>;

function xmlAttribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(source);
  return match?.[2] ?? null;
}

function normalizeArchivePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new EpubTransformError("invalid-epub");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function relativeArchivePath(baseFile: string, href: string): string {
  if (href.startsWith("/") || href.includes("\\")) {
    throw new EpubTransformError("invalid-epub");
  }
  const base = baseFile.split("/").slice(0, -1).join("/");
  let decoded: string;
  try {
    decoded = decodeURIComponent(href)
      .replaceAll("&amp;", "&")
      .replaceAll("&apos;", "'")
      .replaceAll("&quot;", '"');
  } catch {
    throw new EpubTransformError("invalid-epub");
  }
  return normalizeArchivePath(base ? `${base}/${decoded}` : decoded);
}

function packagePath(entries: Readonly<Record<string, Uint8Array>>): string {
  const container = entries["META-INF/container.xml"];
  if (!container) throw new EpubTransformError("invalid-epub");
  const rootfile = /<rootfile\b[^>]*>/i.exec(strFromU8(container))?.[0];
  const path = rootfile && xmlAttribute(rootfile, "full-path");
  if (!path) throw new EpubTransformError("invalid-epub");
  return normalizeArchivePath(path);
}

function transformPackageDocument(source: string): string {
  const declaredCoverId = [...source.matchAll(/<meta\b[^>]*>/gi)]
    .find((match) => xmlAttribute(match[0], "name")?.toLowerCase() === "cover");
  const coverId = declaredCoverId ? xmlAttribute(declaredCoverId[0], "content") : "cover";
  if (!coverId) return source;

  return source.replace(/<item\b[^>]*>/gi, (item) => {
    if (xmlAttribute(item, "id") !== coverId) return item;
    const properties = xmlAttribute(item, "properties")?.split(/\s+/).filter(Boolean) ?? [];
    if (properties.includes("cover-image")) return item;
    properties.push("cover-image");
    if (/\bproperties\s*=/i.test(item)) {
      return item.replace(/\bproperties\s*=\s*(["'])(.*?)\1/i, `properties="${properties.join(" ")}"`);
    }
    return item.replace(/\s*\/?\s*>$/, (ending) => ` properties="${properties.join(" ")}"${ending}`);
  });
}

function validatedEntries(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const validated: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path || path.includes("\0") || path.startsWith("/") || path.includes("\\")) {
      throw new EpubTransformError("invalid-epub");
    }
    const canonical = normalizeArchivePath(path);
    if (canonical !== path || Object.hasOwn(validated, canonical)) {
      throw new EpubTransformError("invalid-epub");
    }
    if (path.endsWith("/")) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new EpubTransformError("archive-limit-exceeded");
    }
    validated[path] = bytes;
  }
  return validated;
}

function spineDocuments(entries: Readonly<Record<string, Uint8Array>>, opfPath: string): string[] {
  const opfBytes = entries[opfPath];
  if (!opfBytes) throw new EpubTransformError("invalid-epub");
  const opf = strFromU8(opfBytes);
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = xmlAttribute(match[0], "id");
    const href = xmlAttribute(match[0], "href");
    const mediaType = xmlAttribute(match[0], "media-type");
    if (id && href && mediaType) manifest.set(id, { href, mediaType });
  }

  const documents: string[] = [];
  const seen = new Set<string>();
  for (const match of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = xmlAttribute(match[0], "idref");
    const item = idref ? manifest.get(idref) : undefined;
    if (!item || !["application/xhtml+xml", "text/html"].includes(item.mediaType)) continue;
    const path = relativeArchivePath(opfPath, item.href.split(/[?#]/, 1)[0] ?? item.href);
    if (!entries[path]) throw new EpubTransformError("invalid-epub");
    if (!seen.has(path)) {
      seen.add(path);
      documents.push(path);
    }
  }
  if (!documents.length) throw new EpubTransformError("invalid-epub");
  return documents;
}

function textSegments(text: string): string[] {
  const segments = text.match(/.*?(?:[.!?]+(?:["'\u2019\u201d)]*)\s+|$)/gs) ?? [];
  return segments.filter(Boolean);
}

function markupTokens(source: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const tagStart = source.indexOf("<", offset);
    if (tagStart < 0) {
      tokens.push(source.slice(offset));
      break;
    }
    if (tagStart > offset) tokens.push(source.slice(offset, tagStart));

    const specialEnd = source.startsWith("<!--", tagStart)
      ? "-->"
      : source.startsWith("<![CDATA[", tagStart)
        ? "]]>"
        : null;
    if (specialEnd) {
      const end = source.indexOf(specialEnd, tagStart + 1);
      if (end < 0) throw new EpubTransformError("invalid-epub");
      const next = end + specialEnd.length;
      tokens.push(source.slice(tagStart, next));
      offset = next;
      continue;
    }

    let quote: "\"" | "'" | null = null;
    let tagEnd = -1;
    for (let index = tagStart + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        tagEnd = index;
        break;
      }
    }
    if (tagEnd < 0) throw new EpubTransformError("invalid-epub");
    tokens.push(source.slice(tagStart, tagEnd + 1));
    offset = tagEnd + 1;
  }
  return tokens;
}

function transformContentDocument(source: string): { source: string; spans: number } {
  const bodyStart = /<body\b[^>]*>/i.exec(source);
  const bodyEnd = /<\/body\s*>/i.exec(source);
  if (!bodyStart || !bodyEnd || bodyEnd.index <= bodyStart.index) {
    throw new EpubTransformError("invalid-epub");
  }

  const start = bodyStart.index + bodyStart[0].length;
  const body = source.slice(start, bodyEnd.index);
  const tokens = markupTokens(body);
  let suppressed = 0;
  let paragraph = 1;
  let segment = 1;
  let spans = 0;
  const output: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("<")) {
      const closing = /^<\//.test(token);
      const name = /^<\/?\s*([a-z0-9:-]+)/i.exec(token)?.[1]?.toLowerCase();
      if (name === "script" || name === "style" || name === "svg" || name === "math") {
        suppressed += closing ? -1 : /\/\s*>$/.test(token) ? 0 : 1;
        suppressed = Math.max(0, suppressed);
      }
      if (closing && /^(?:p|div|li|blockquote|h[1-6]|pre|td|th)$/.test(name ?? "")) {
        paragraph += 1;
        segment = 1;
      }
      output.push(token);
      continue;
    }

    if (suppressed || !/\S/.test(token)) {
      output.push(token);
      continue;
    }
    for (const part of textSegments(token)) {
      if (!/\S/.test(part)) {
        output.push(part);
        continue;
      }
      output.push(`<span class="koboSpan" id="kobo.${paragraph}.${segment}">${part}</span>`);
      segment += 1;
      spans += 1;
    }
  }

  return {
    source: source.slice(0, start) + output.join("") + source.slice(bodyEnd.index),
    spans,
  };
}

export function transformEpubToKepub(input: Uint8Array): KepubTransformReport {
  if (!input.byteLength || input.byteLength > MAX_ARCHIVE_BYTES) {
    throw new EpubTransformError("archive-limit-exceeded");
  }
  preflightZip(input);

  let entries: Record<string, Uint8Array>;
  try {
    entries = validatedEntries(unzipSync(input));
  } catch {
    throw new EpubTransformError("invalid-epub");
  }
  if (Object.keys(entries).length > MAX_ENTRY_COUNT) {
    throw new EpubTransformError("archive-limit-exceeded");
  }
  if (strFromU8(entries.mimetype ?? new Uint8Array()) !== MIMETYPE) {
    throw new EpubTransformError("invalid-epub");
  }

  const opfPath = packagePath(entries);
  const documents = spineDocuments(entries, opfPath);
  entries[opfPath] = strToU8(transformPackageDocument(strFromU8(entries[opfPath]!)));
  let spans = 0;
  for (const path of documents) {
    const transformed = transformContentDocument(strFromU8(entries[path]!));
    entries[path] = strToU8(transformed.source);
    spans += transformed.spans;
  }

  const archive: Zippable = { mimetype: [strToU8(MIMETYPE), { level: 0 }] };
  for (const [path, bytes] of Object.entries(entries)) {
    if (path !== "mimetype") archive[path] = bytes;
  }
  return { bytes: zipSync(archive, { level: 6 }), contentDocuments: documents.length, spans };
}
