import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LibraryItem } from "@takio/core";
import type {
  LibraryImportEntryOutcome,
  LibraryMetadataPatch,
} from "@takio/library-contract";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enrichImportedLibraryOutcomes,
  type MetadataImportStore,
} from "../src/library-import.js";

const FAKE_BACKEND = join(import.meta.dir, "fixtures/fake-ebook-meta.ts");
const ADDED_AT = "2026-07-20T12:00:00.000Z";
const roots: string[] = [];
let priorBackend: string | undefined;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-library-import-metadata-test-"));
  roots.push(root);
  return root;
}

async function managedItem(
  root: string,
  id: string,
  control: Record<string, unknown>,
  provenance: "managed" | "referenced" = "managed",
): Promise<LibraryItem> {
  const sourcePath = join(root, `${id}.epub`);
  await writeFile(sourcePath, JSON.stringify({ fakeEbookMeta: control }));
  return {
    id,
    title: id,
    sourcePath,
    format: "epub",
    addedAt: ADDED_AT,
    formats: [{ sourcePath, format: "epub", addedAt: ADDED_AT, provenance }],
    tags: [],
  };
}

function imported(item: LibraryItem): LibraryImportEntryOutcome {
  return { status: "imported", sourcePath: `/original/${item.id}.epub`, item };
}

function updatedItem(item: LibraryItem, patch: LibraryMetadataPatch): LibraryItem {
  return {
    ...item,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.authors === undefined || patch.authors === null
      ? {}
      : { authors: patch.authors }),
    tags: patch.tags,
    updatedAt: "2026-07-20T12:01:00.000Z",
  };
}

beforeEach(() => {
  priorBackend = process.env.TAKIO_EBOOK_META;
  process.env.TAKIO_EBOOK_META = FAKE_BACKEND;
});

afterEach(async () => {
  if (priorBackend === undefined) {
    delete process.env.TAKIO_EBOOK_META;
  } else {
    process.env.TAKIO_EBOOK_META = priorBackend;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("library import metadata enrichment", () => {
  it("enriches managed imports sequentially, installs verified covers, and preserves other outcomes", async () => {
    const root = await temporaryRoot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const first = await managedItem(root, "first", {
      opf: `<package><metadata><dc:title>First extracted</dc:title>
        <dc:creator opf:role="aut">First Author</dc:creator></metadata></package>`,
      coverBase64: png.toString("base64"),
    });
    const second = await managedItem(root, "second", {
      opf: "<package><metadata><dc:title>Second extracted</dc:title></metadata></package>",
    });
    const referenced = await managedItem(root, "referenced", {}, "referenced");
    const skipped: LibraryImportEntryOutcome = {
      status: "skipped",
      sourcePath: join(root, "notes.txt"),
      reason: "unsupported-format",
    };
    const outcomes = [imported(first), skipped, imported(referenced), imported(second)] as const;
    const calls: string[] = [];
    let temporaryCoverPath: string | undefined;

    const store: MetadataImportStore = {
      update: async ({ id, patch }) => {
        calls.push(`update:${id}:${patch.title}`);
        const original = id === first.id ? first : second;
        return { ok: true, value: updatedItem(original, patch) };
      },
      setCover: async ({ id, sourcePath }) => {
        calls.push(`cover:${id}`);
        temporaryCoverPath = sourcePath;
        expect(await readFile(sourcePath)).toEqual(png);
        const base = updatedItem(first, {
          title: "First extracted",
          authors: [{ name: "First Author" }],
          tags: [],
        });
        return { ok: true, value: { ...base, coverPath: `/covers/${id}.png` } };
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, outcomes);

    expect(calls).toEqual([
      "update:first:First extracted",
      "cover:first",
      "update:second:Second extracted",
    ]);
    expect(result[0]).toMatchObject({
      status: "imported",
      sourcePath: "/original/first.epub",
      item: {
        title: "First extracted",
        authors: [{ name: "First Author" }],
        coverPath: "/covers/first.png",
      },
    });
    expect(result[1]).toBe(skipped);
    expect(result[2]).toBe(outcomes[2]);
    expect(result[3]).toMatchObject({ item: { title: "Second extracted" } });
    expect(temporaryCoverPath).toBeDefined();
    expect(stat(temporaryCoverPath!)).rejects.toThrow();
  });

  it("lets a single-import title override win over extracted metadata", async () => {
    const root = await temporaryRoot();
    const item = await managedItem(root, "title", {
      opf: "<package><metadata><dc:title>Extracted title</dc:title></metadata></package>",
    });
    let receivedPatch: LibraryMetadataPatch | undefined;
    const store: MetadataImportStore = {
      update: async ({ patch }) => {
        receivedPatch = patch;
        return { ok: true, value: updatedItem(item, patch) };
      },
      setCover: async () => {
        throw new Error("No cover expected");
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, [imported(item)], {
      titleOverride: "Explicit title",
    });

    expect(receivedPatch).toEqual({ title: "Explicit title", tags: [] });
    expect(result[0]).toMatchObject({ item: { title: "Explicit title" } });
  });

  it("preserves imports across discovery, extraction, metadata update, and cover failures", async () => {
    const root = await temporaryRoot();
    const extractionFailure = await managedItem(root, "extract-failure", { mode: "nonzero" });
    const updateFailure = await managedItem(root, "update-failure", {
      opf: "<package><metadata><dc:title>Update attempted</dc:title></metadata></package>",
    });
    const coverFailure = await managedItem(root, "cover-failure", {
      opf: "<package><metadata><dc:title>Metadata survives</dc:title></metadata></package>",
      coverBase64: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString("base64"),
    });
    const extractionOutcome = imported(extractionFailure);
    const updateOutcome = imported(updateFailure);
    const coverOutcome = imported(coverFailure);
    const calls: string[] = [];
    const store: MetadataImportStore = {
      update: async ({ id, patch }) => {
        calls.push(`update:${id}`);
        if (id === updateFailure.id) {
          return { ok: false, error: { code: "storage-unavailable" } };
        }
        return { ok: true, value: updatedItem(coverFailure, patch) };
      },
      setCover: async ({ id }) => {
        calls.push(`cover:${id}`);
        return { ok: false, error: { code: "storage-unavailable" } };
      },
    };

    const result = await enrichImportedLibraryOutcomes(store, [
      extractionOutcome,
      updateOutcome,
      coverOutcome,
    ]);

    expect(calls).toEqual(["update:update-failure", "update:cover-failure", "cover:cover-failure"]);
    expect(result[0]).toBe(extractionOutcome);
    expect(result[1]).toBe(updateOutcome);
    expect(result[2]).toMatchObject({
      status: "imported",
      item: { id: "cover-failure", title: "Metadata survives" },
    });

    process.env.TAKIO_EBOOK_META = join(root, "missing-ebook-meta");
    const undiscovered = await enrichImportedLibraryOutcomes(store, [coverOutcome]);
    expect(undiscovered[0]).toBe(coverOutcome);
    expect(calls).toHaveLength(3);
  });
});
