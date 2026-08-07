import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import { FORMAT_IDS, detectFormat, type FormatId } from "@takio/core";
import type { BunSqliteLibraryStore } from "@takio/library-store-bun";

import { catalogRecord } from "./catalog.js";

const MAX_PAGE_SIZE = 256;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_CATALOG_RESPONSE_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES: Readonly<Record<FormatId, string>> = {
  kepub: "application/epub+zip",
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  cbz: "application/vnd.comicbook+zip",
};

type ReadableLibraryStore = Pick<BunSqliteLibraryStore, "get" | "query">;

export class ContentServerError extends Error {
  constructor(readonly code: "invalid-arguments" | "server-unavailable") {
    super(code);
  }
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function error(code: string, status: number, headers?: HeadersInit): Response {
  return json({ ok: false, error: { code } }, status, headers);
}

function catalogJson(value: unknown): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_CATALOG_RESPONSE_BYTES) {
    return error("response-too-large", 503);
  }
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

export function holdRequestUntilBodyDone(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          releaseOnce();
        } else {
          controller.enqueue(next.value);
        }
      } catch (cause) {
        controller.error(cause);
        releaseOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseOnce();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function authorized(request: Request, tokenDigest: Buffer): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.length > 1024) return false;
  const candidateDigest = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(candidateDigest, tokenDigest);
}

function parsePage(url: URL): { limit: number; offset: number } | undefined {
  const limitText = url.searchParams.get("limit") ?? "100";
  const offsetText = url.searchParams.get("offset") ?? "0";
  if ([...url.searchParams.keys()].some((key) => key !== "limit" && key !== "offset")) {
    return undefined;
  }
  const limit = Number(limitText);
  const offset = Number(offsetText);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE &&
      Number.isSafeInteger(offset) && offset >= 0 && offset <= 1_000_000
    ? { limit, offset }
    : undefined;
}

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

async function route(request: Request, store: ReadableLibraryStore): Promise<Response> {
  if (request.method !== "GET") return error("method-not-allowed", 405, { allow: "GET" });
  if (request.url.length > 2048) return error("invalid-request", 400);

  const url = new URL(request.url);
  if (url.pathname === "/v1/health") {
    if (url.search) return error("invalid-request", 400);
    return json({ ok: true, value: { service: "takio", protocolVersion: 1 } });
  }

  if (url.pathname === "/v1/books" || url.pathname === "/v1/catalog") {
    const page = parsePage(url);
    if (!page) return error("invalid-request", 400);
    const listed = await store.query({
      query: "",
      filters: { authors: [], tags: [], series: [], languages: [], formats: [] },
      sort: { field: "title", direction: "ascending" },
      page,
    });
    if (!listed.ok) return error(listed.error.code, 503);
    const books = listed.value.items.map(catalogRecord);
    let catalogBytes = 0;
    for (const book of books) {
      catalogBytes += Buffer.byteLength(JSON.stringify(book), "utf8") + 1;
      if (catalogBytes > MAX_CATALOG_RESPONSE_BYTES) {
        return error("response-too-large", 503);
      }
    }
    return catalogJson({
      ok: true,
      value: { books, offset: page.offset, limit: page.limit, total: listed.value.total },
    });
  }

  const fileMatch = /^\/v1\/books\/([^/]+)\/formats\/([^/]+)$/.exec(url.pathname);
  if (fileMatch) {
    if (url.search) return error("invalid-request", 400);
    const id = decodeSegment(fileMatch[1]!);
    const format = FORMAT_IDS.find((candidate) => candidate === fileMatch[2]);
    if (!id || !format) return error("invalid-request", 400);
    const found = await store.get({ id });
    if (!found.ok) return error(found.error.code, 503);
    if (!found.value) return error("not-found", 404);
    const attachment = found.value.formats.find((candidate) => candidate.format === format);
    if (!attachment) return error("format-not-found", 404);
    if (detectFormat(attachment.sourcePath) !== format) return error("format-mismatch", 409);
    try {
      const path = await realpath(attachment.sourcePath);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size === 0) return error("missing-file", 404);
      const fileName = encodeURIComponent(basename(attachment.sourcePath)).replaceAll("'", "%27");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename*=UTF-8''${fileName}`,
          "content-length": String(metadata.size),
          "content-type": CONTENT_TYPES[format],
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return error("missing-file", 404);
    }
  }

  const itemMatch = /^\/v1\/books\/([^/]+)$/.exec(url.pathname);
  if (itemMatch) {
    if (url.search) return error("invalid-request", 400);
    const id = decodeSegment(itemMatch[1]!);
    if (!id) return error("invalid-request", 400);
    const found = await store.get({ id });
    if (!found.ok) return error(found.error.code, 503);
    return found.value
      ? catalogJson({ ok: true, value: { book: catalogRecord(found.value) } })
      : error("not-found", 404);
  }

  return error("not-found", 404);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

async function tlsFile(path: string): Promise<Bun.BunFile> {
  try {
    const resolved = await realpath(path);
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1024 * 1024) throw new Error();
    return Bun.file(resolved);
  } catch {
    throw new ContentServerError("invalid-arguments");
  }
}

export async function startContentServer(options: {
  readonly store: ReadableLibraryStore;
  readonly hostname: string;
  readonly port: number;
  readonly allowRemote?: boolean;
  readonly certPath?: string;
  readonly keyPath?: string;
  readonly token?: string;
}): Promise<{ readonly server: Bun.Server<undefined>; readonly token: string; readonly url: string }> {
  const remote = !isLoopback(options.hostname);
  const hasCertificate = options.certPath !== undefined || options.keyPath !== undefined;
  if (
    options.hostname === "" || !Number.isSafeInteger(options.port) || options.port < 0 ||
    options.port > 65_535 || (remote && (!options.allowRemote || !options.certPath || !options.keyPath)) ||
    (hasCertificate && (!options.certPath || !options.keyPath))
  ) {
    throw new ContentServerError("invalid-arguments");
  }

  const token = options.token ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 1024) {
    throw new ContentServerError("invalid-arguments");
  }
  const tokenDigest = createHash("sha256").update(`Bearer ${token}`).digest();
  const tls = options.certPath && options.keyPath
    ? { cert: await tlsFile(options.certPath), key: await tlsFile(options.keyPath) }
    : undefined;
  let activeRequests = 0;
  try {
    const server = Bun.serve({
      hostname: options.hostname,
      port: options.port,
      ...(tls ? { tls } : {}),
      maxRequestBodySize: 1024,
      development: false,
      error: () => error("internal-error", 500),
      async fetch(request) {
        if (!authorized(request, tokenDigest)) {
          return error("unauthorized", 401, { "www-authenticate": "Bearer" });
        }
        if (activeRequests >= MAX_ACTIVE_REQUESTS) return error("server-busy", 503);
        activeRequests += 1;
        try {
          return holdRequestUntilBodyDone(await route(request, options.store), () => {
            activeRequests -= 1;
          });
        } catch (cause) {
          activeRequests -= 1;
          throw cause;
        }
      },
    });
    const protocol = tls ? "https" : "http";
    const displayHost = options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname;
    return { server, token, url: `${protocol}://${displayHost}:${server.port}` };
  } catch (error) {
    if (error instanceof ContentServerError) throw error;
    throw new ContentServerError("server-unavailable");
  }
}
