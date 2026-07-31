import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunSqliteLibraryStore } from "@takio/library-store-bun";
import type { QueryLibraryItemsRequest } from "@takio/library-contract";

import { ContentServerError, startContentServer } from "../src/remote-server.js";

const TOKEN = "test-token-with-at-least-thirty-two-bytes";
let directory: string | undefined;
let server: Bun.Server<undefined> | undefined;
let store: BunSqliteLibraryStore | undefined;

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("No test port.");
  return address.port;
}

afterEach(async () => {
  await server?.stop(true);
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  store = undefined;
  directory = undefined;
});

describe("authenticated content server", () => {
  it("authenticates every route and exposes only catalog data or selected attached bytes", async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-server-"));
    const sourcePath = join(directory, "source.epub");
    await Bun.write(sourcePath, "ebook bytes");
    await mkdir(join(directory, "library"));
    store = new BunSqliteLibraryStore(join(directory, "library", "library.sqlite"));
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    expect(await store.add({
      item: {
        id: "remote-book",
        title: "Remote book",
        sourcePath,
        format: "epub",
        addedAt: "2026-07-31T12:00:00.000Z",
        formats: [{
          sourcePath,
          format: "epub",
          addedAt: "2026-07-31T12:00:00.000Z",
          provenance: "referenced",
        }],
        tags: [],
      },
    })).toMatchObject({ ok: true });

    const running = await startContentServer({
      store,
      hostname: "127.0.0.1",
      port: 0,
      token: TOKEN,
    });
    server = running.server;

    const unauthorized = await fetch(`${running.url}/v1/books`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: { code: "unauthorized" } });

    const headers = { authorization: `Bearer ${TOKEN}` };
    const listed = await fetch(`${running.url}/v1/books`, { headers });
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).toContain("Remote book");
    expect(body).not.toContain(sourcePath);

    const downloaded = await fetch(
      `${running.url}/v1/books/remote-book/formats/epub`,
      { headers },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/epub+zip");
    expect(await downloaded.text()).toBe("ebook bytes");
  });

  it("requires explicit permission and TLS for non-loopback binding", async () => {
    const reader = {
      query: async () => ({
        ok: true as const,
        value: {
          items: [],
          total: 0,
          page: { offset: 0, limit: 100 },
          facets: { authors: [], tags: [], series: [], languages: [], formats: [] },
        },
      }),
      get: async () => ({ ok: true as const, value: null }),
    };
    await expect(startContentServer({
      store: reader,
      hostname: "0.0.0.0",
      port: 0,
      allowRemote: true,
      token: TOKEN,
    })).rejects.toEqual(new ContentServerError("invalid-arguments"));
  });

  it("pushes HTTP pagination into the bounded library query", async () => {
    let request: QueryLibraryItemsRequest | undefined;
    const reader = {
      query: async (value: QueryLibraryItemsRequest) => {
        request = value;
        return {
          ok: true as const,
          value: {
            items: [],
            total: 300,
            page: value.page,
            facets: { authors: [], tags: [], series: [], languages: [], formats: [] },
          },
        };
      },
      get: async () => ({ ok: true as const, value: null }),
    };
    const running = await startContentServer({
      store: reader,
      hostname: "127.0.0.1",
      port: 0,
      token: TOKEN,
    });
    server = running.server;

    const response = await fetch(`${running.url}/v1/books?limit=25&offset=275`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(request?.page).toEqual({ limit: 25, offset: 275 });
  });

  it("starts through the CLI, prints its generated credential once, and stops on SIGTERM", async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-server-cli-"));
    const port = await availablePort();
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/main.ts"), "serve", "--port", String(port)],
      env: { ...process.env, TAKIO_DATA_DIR: join(directory, "data") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let startup = "";
      while (!startup.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        startup += decoder.decode(chunk.value, { stream: true });
      }
      const response = JSON.parse(startup.trim()) as {
        value: { server: { url: string; token: string; mode: string } };
      };
      expect(response.value.server).toMatchObject({
        url: `http://127.0.0.1:${port}`,
        mode: "foreground-read-only",
      });
      expect(response.value.server.token.length).toBeGreaterThanOrEqual(32);
      const health = await fetch(`${response.value.server.url}/v1/health`, {
        headers: { authorization: `Bearer ${response.value.server.token}` },
      });
      expect(await health.json()).toEqual({
        ok: true,
        value: { service: "takio", protocolVersion: 1 },
      });
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
