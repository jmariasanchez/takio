import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MetadataError,
  discoverEbookMeta,
  extractEbookMetadata,
} from "../src/metadata.js";

const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-meta.ts");
const CLI = join(import.meta.dir, "../src/main.ts");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-metadata-test-"));
  roots.push(root);
  return root;
}

async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function source(
  root: string,
  name: string,
  control: Record<string, unknown>,
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify({ fakeEbookMeta: control }));
  return path;
}

async function expectMetadataError(
  promise: Promise<unknown>,
  code: MetadataError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected metadata extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataError);
    expect((error as MetadataError).code).toBe(code);
  }
}

async function invokeMetadata(
  args: readonly string[],
  environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, "metadata", "extract", ...args], {
    env: { ...process.env, TAKIO_EBOOK_META: FAKE_BACKEND, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ebook-meta discovery", () => {
  it("uses a configured executable before PATH or the macOS bundle", async () => {
    const root = await temporaryRoot();
    const configured = join(root, "configured");
    const fromPath = join(root, "ebook-meta");
    const bundle = join(root, "bundle");
    await Promise.all([executable(configured), executable(fromPath), executable(bundle)]);

    expect(
      await discoverEbookMeta(
        { TAKIO_EBOOK_META: configured, PATH: root },
        "darwin",
        bundle,
      ),
    ).toEqual({ ok: true, path: await realpath(configured) });
  });

  it("uses PATH before the macOS bundle and the bundle after a PATH miss", async () => {
    const root = await temporaryRoot();
    const fromPath = join(root, "ebook-meta");
    const bundle = join(root, "bundle");
    await Promise.all([executable(fromPath), executable(bundle)]);

    expect(await discoverEbookMeta({ PATH: root }, "darwin", bundle)).toEqual({
      ok: true,
      path: await realpath(fromPath),
    });
    expect(await discoverEbookMeta({ PATH: "" }, "darwin", bundle)).toEqual({
      ok: true,
      path: await realpath(bundle),
    });
  });

  it("fails closed for an empty or unusable configured override", async () => {
    const root = await temporaryRoot();
    const fromPath = join(root, "ebook-meta");
    await executable(fromPath);

    expect(
      await discoverEbookMeta({ TAKIO_EBOOK_META: "", PATH: root }, "darwin", fromPath),
    ).toEqual({ ok: false, code: "invalid-arguments" });
    expect(
      await discoverEbookMeta(
        { TAKIO_EBOOK_META: join(root, "missing"), PATH: root },
        "darwin",
        fromPath,
      ),
    ).toEqual({ ok: false, code: "backend-unavailable" });
  });
});

describe("ebook-meta extraction", () => {
  it("exposes normalized metadata through one machine-safe CLI record", async () => {
    const root = await temporaryRoot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const input = await source(root, "inspect.epub", {
      opf: `<package><metadata>
        <dc:title>Inspectable Book</dc:title>
        <dc:creator opf:role="aut">Agent Author</dc:creator>
        <dc:identifier opf:scheme="ISBN">9780000000001</dc:identifier>
      </metadata></package>`,
      coverBase64: png.toString("base64"),
    });

    const result = await invokeMetadata(["--source-path", input]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const line = result.stdout.trim();
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(JSON.parse(line)).toEqual({
      ok: true,
      value: {
        sourcePath: await realpath(input),
        metadata: {
          title: "Inspectable Book",
          authors: [{ name: "Agent Author" }],
          identifiers: { isbn: "9780000000001" },
          tags: [],
        },
        cover: { mediaType: "image/png", extension: ".png", bytes: png.byteLength },
      },
    });
  });

  it("reports metadata CLI discovery and argument failures without prose", async () => {
    const root = await temporaryRoot();
    const input = await source(root, "inspect.epub", {});
    const cases = [
      await invokeMetadata(["--source-path", input, "--timeout-seconds", "0"]),
      await invokeMetadata(
        ["--source-path", input],
        { TAKIO_EBOOK_META: join(root, "missing-backend") },
      ),
    ];

    expect(JSON.parse(cases[0]!.stdout)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(JSON.parse(cases[1]!.stdout)).toEqual({
      ok: false,
      error: { code: "backend-unavailable" },
    });
    for (const result of cases) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(/Usage:|Options:|Commands:/);
    }
  });

  it("maps Calibre OPF metadata, verifies the cover, and uses literal canonical argv", async () => {
    const root = await temporaryRoot();
    const record = join(root, "invocation.json");
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns="http://www.idpf.org/2007/opf"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:opf="http://www.idpf.org/2007/opf">
        <metadata>
          <dc:title> The Left Hand of Darkness </dc:title>
          <dc:creator opf:role="aut" opf:file-as="Le Guin, Ursula K.">Ursula K. Le Guin</dc:creator>
          <dc:creator opf:role="edt">Ignored Editor</dc:creator>
          <dc:creator opf:role="aut">Second Author</dc:creator>
          <dc:publisher>Ace Books</dc:publisher>
          <dc:language>en_US</dc:language>
          <dc:language>fr</dc:language>
          <dc:identifier opf:scheme="ISBN">9780441478125</dc:identifier>
          <dc:identifier opf:scheme="Goodreads">77203</dc:identifier>
          <dc:date>1969-03-01T00:00:00+00:00</dc:date>
          <dc:description><![CDATA[A classic novel.]]></dc:description>
          <dc:subject>Science Fiction</dc:subject>
          <dc:subject> science fiction </dc:subject>
          <dc:subject>Classic</dc:subject>
          <meta name="calibre:series" content="Hainish Cycle"/>
          <meta name="calibre:series_index" content="4.5"/>
          <meta name="calibre:rating" content="9"/>
        </metadata>
      </package>`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const input = await source(root, "- book;$(touch nope).epub", {
      opf,
      coverBase64: png.toString("base64"),
      record,
    });

    process.env.TAKIO_TEST_SECRET = "must-not-reach-backend";
    try {
      const result = await extractEbookMetadata({
        backendPath: FAKE_BACKEND,
        sourcePath: input,
        timeoutMs: 5_000,
      });
      expect(result).toEqual({
        sourcePath: await realpath(input),
        metadata: {
          title: "The Left Hand of Darkness",
          authors: [
            { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
            { name: "Second Author" },
          ],
          series: "Hainish Cycle",
          seriesIndex: 4.5,
          publisher: "Ace Books",
          languages: ["en-US", "fr"],
          identifiers: { isbn: "9780441478125", goodreads: "77203" },
          publishedDate: "1969-03-01",
          rating: 9,
          description: "A classic novel.",
          tags: ["Science Fiction", "Classic"],
        },
        cover: { bytes: png, extension: ".png", mediaType: "image/png" },
      });
    } finally {
      delete process.env.TAKIO_TEST_SECRET;
    }

    const invocation = JSON.parse(await readFile(record, "utf8")) as {
      argv: string[];
      cwd: string;
      tmpdir: string;
      environmentKeys: string[];
    };
    expect(invocation.argv).toEqual([
      await realpath(input),
      `--to-opf=${join(invocation.tmpdir, "metadata.opf")}`,
      `--get-cover=${join(invocation.tmpdir, "cover")}`,
      "--disallow-rendered-cover",
    ]);
    expect(invocation.cwd.replace(/^\/private/, "")).toBe(
      invocation.tmpdir.replace(/^\/private/, ""),
    );
    expect(invocation.environmentKeys).not.toContain("TAKIO_TEST_SECRET");
    expect(stat(invocation.tmpdir)).rejects.toThrow();
  });

  it("keeps valid metadata while omitting invalid optional fields and an invalid cover", async () => {
    const root = await temporaryRoot();
    const input = await source(root, "partial.epub", {
      opf: `<package><metadata>
        <dc:title>Partial</dc:title>
        <dc:language>not a language</dc:language>
        <dc:language>en</dc:language>
        <dc:date>2026-99-99</dc:date>
        <meta name="calibre:rating" content="11"/>
      </metadata></package>`,
      coverBase64: Buffer.from("not an image").toString("base64"),
    });

    expect(
      await extractEbookMetadata({
        backendPath: FAKE_BACKEND,
        sourcePath: input,
        timeoutMs: 5_000,
      }),
    ).toEqual({
      sourcePath: await realpath(input),
      metadata: { title: "Partial", languages: ["en"], tags: [] },
      cover: null,
    });
  });

  it("reports stable failures and always removes its private workspace", async () => {
    const root = await temporaryRoot();
    for (const fixture of [
      { name: "nonzero.epub", control: { mode: "nonzero" }, code: "metadata-extraction-failed" },
      { name: "missing.epub", control: { mode: "missing" }, code: "metadata-invalid" },
      { name: "malformed.epub", control: { opf: "<package>" }, code: "metadata-invalid" },
      {
        name: "external-entity.epub",
        control: {
          opf: `<!DOCTYPE package [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
            <package><metadata><dc:title>&xxe;</dc:title></metadata></package>`,
        },
        code: "metadata-invalid",
      },
      {
        name: "oversized.epub",
        control: { opfBytes: 2 * 1024 * 1024 + 1 },
        code: "metadata-invalid",
      },
    ] as const) {
      const record = join(root, `${fixture.name}.json`);
      const input = await source(root, fixture.name, { ...fixture.control, record });
      await expectMetadataError(
        extractEbookMetadata({
          backendPath: FAKE_BACKEND,
          sourcePath: input,
          timeoutMs: 5_000,
        }),
        fixture.code,
      );
      const invocation = JSON.parse(await readFile(record, "utf8")) as { tmpdir: string };
      expect(stat(invocation.tmpdir)).rejects.toThrow();
    }
  });

  it("discards an oversized extracted cover without losing valid metadata", async () => {
    const root = await temporaryRoot();
    const input = await source(root, "oversized-cover.epub", {
      opf: "<package><metadata><dc:title>Still Imported</dc:title></metadata></package>",
      coverBytes: 32 * 1024 * 1024 + 1,
    });

    expect(
      await extractEbookMetadata({
        backendPath: FAKE_BACKEND,
        sourcePath: input,
        timeoutMs: 5_000,
      }),
    ).toEqual({
      sourcePath: await realpath(input),
      metadata: { title: "Still Imported", tags: [] },
      cover: null,
    });
  });

  it("kills a timed-out backend and cleans its workspace", async () => {
    const root = await temporaryRoot();
    const record = join(root, "timeout.json");
    const input = await source(root, "timeout.epub", { mode: "sleep", record });

    await expectMetadataError(
      extractEbookMetadata({
        backendPath: FAKE_BACKEND,
        sourcePath: input,
        timeoutMs: 25,
      }),
      "metadata-timeout",
    );
    const invocation = JSON.parse(await readFile(record, "utf8")) as { tmpdir: string };
    expect(stat(invocation.tmpdir)).rejects.toThrow();
  });

  it("validates arguments, backend availability, and source availability before spawning", async () => {
    const root = await temporaryRoot();
    const input = await source(root, "book.epub", {});

    await expectMetadataError(
      extractEbookMetadata({ backendPath: FAKE_BACKEND, sourcePath: input, timeoutMs: 0 }),
      "invalid-arguments",
    );
    await expectMetadataError(
      extractEbookMetadata({
        backendPath: join(root, "missing-backend"),
        sourcePath: input,
        timeoutMs: 1_000,
      }),
      "backend-unavailable",
    );
    await expectMetadataError(
      extractEbookMetadata({
        backendPath: FAKE_BACKEND,
        sourcePath: join(root, "missing.epub"),
        timeoutMs: 1_000,
      }),
      "source-unavailable",
    );
  });
});
