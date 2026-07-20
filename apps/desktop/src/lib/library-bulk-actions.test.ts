import { describe, expect, test } from "bun:test";
import type { BookFormat, LibraryItem } from "@takio/core";

import {
  applyBulkTagOperation,
  hydrateSelectedLibraryItems,
  planBulkDeviceSend,
  planBulkPdfConversion,
} from "./library-bulk-actions";

function bookFormat(format: BookFormat["format"], sourcePath: string): BookFormat {
  return {
    format,
    sourcePath,
    provenance: "referenced",
    addedAt: "2026-07-20T12:00:00.000Z",
  };
}

function libraryItem(
  id: string,
  formats: readonly BookFormat[],
  tags: readonly string[] = [],
): LibraryItem {
  const primary = formats[0];
  if (!primary) {
    throw new TypeError("A test library item needs a format.");
  }
  return {
    id,
    title: `Book ${id}`,
    sourcePath: primary.sourcePath,
    format: primary.format,
    addedAt: "2026-07-20T12:00:00.000Z",
    formats,
    tags,
  };
}

describe("bulk tag operations", () => {
  test("adds normalized new tags while preserving existing spelling and order", () => {
    const current = Object.freeze([" Science Fiction ", "Classic", "classic"]);
    const requested = Object.freeze([" classic ", " Award  Winner ", "award winner", " "]);

    expect(applyBulkTagOperation(current, "add", requested)).toEqual([
      "Science Fiction",
      "Classic",
      "Award Winner",
    ]);
    expect(current).toEqual([" Science Fiction ", "Classic", "classic"]);
    expect(requested).toEqual([" classic ", " Award  Winner ", "award winner", " "]);
  });

  test("removes case-insensitively without disturbing retained tags", () => {
    expect(
      applyBulkTagOperation(
        ["Science Fiction", "Classic", "Award Winner"],
        "remove",
        [" classic ", "CLASSIC", "missing"],
      ),
    ).toEqual(["Science Fiction", "Award Winner"]);
  });

  test(
    "replaces with normalized stable tags and treats an empty request as an explicit clear",
    () => {
      expect(
        applyBulkTagOperation(["Old"], "replace", [" New ", "new", "Another"]),
      ).toEqual(["New", "Another"]);
      expect(applyBulkTagOperation(["Old"], "replace", [])).toEqual([]);
      expect(applyBulkTagOperation(["Old"], "add", [])).toEqual(["Old"]);
      expect(applyBulkTagOperation(["Old"], "remove", [])).toEqual(["Old"]);
    },
  );
});

describe("selected library item hydration", () => {
  test("preserves ID order with exact found, missing, and failure accounting", async () => {
    const first = libraryItem("first", [bookFormat("epub", "/Books/first.epub")]);
    const last = libraryItem("last", [bookFormat("pdf", "/Books/last.pdf")]);
    const calls: string[] = [];
    const selectedIds = Object.freeze(["first", "missing", "reported", "thrown", "last"]);

    const result = await hydrateSelectedLibraryItems(selectedIds, async (id) => {
      calls.push(id);
      switch (id) {
        case "first":
          return { ok: true, value: { item: first } };
        case "missing":
          return { ok: true, value: { item: null } };
        case "reported":
          return { ok: false, error: { code: "storage-unavailable" } };
        case "thrown":
          throw new Error("bridge unavailable");
        case "last":
          return { ok: true, value: { item: last } };
        default:
          throw new Error(`Unexpected id ${id}`);
      }
    });

    expect(calls).toEqual([...selectedIds]);
    expect(result).toEqual({
      outcomes: [
        { status: "found", id: "first", item: first },
        { status: "missing", id: "missing" },
        { status: "failed", id: "reported", code: "storage-unavailable" },
        { status: "failed", id: "thrown", code: "lookup-threw" },
        { status: "found", id: "last", item: last },
      ],
      counts: { total: 5, found: 2, missing: 1, failed: 2 },
    });
    expect(selectedIds).toEqual(["first", "missing", "reported", "thrown", "last"]);
  });

  test("returns zero accounting without looking up an empty selection", async () => {
    let called = false;
    const result = await hydrateSelectedLibraryItems([], async () => {
      called = true;
      return { ok: true, value: { item: null } };
    });

    expect(result).toEqual({
      outcomes: [],
      counts: { total: 0, found: 0, missing: 0, failed: 0 },
    });
    expect(called).toBe(false);
  });
});

describe("bulk conversion planning", () => {
  test("uses only EPUB sources without attached PDFs and explicitly skips every other item", () => {
    const epubOnly = libraryItem("epub", [bookFormat("epub", "/Books/epub.epub")]);
    const alreadyPdf = libraryItem("both", [
      bookFormat("epub", "/Books/both.epub"),
      bookFormat("pdf", "/Books/both.pdf"),
    ]);
    const unavailable = libraryItem("mobi", [bookFormat("mobi", "/Books/mobi.mobi")]);
    const items = Object.freeze([alreadyPdf, epubOnly, unavailable]);

    const plan = planBulkPdfConversion(items);

    expect(plan).toEqual([
      { status: "skipped", item: alreadyPdf, reason: "pdf-already-attached" },
      { status: "eligible", item: epubOnly, source: epubOnly.formats[0], target: "pdf" },
      { status: "skipped", item: unavailable, reason: "epub-source-unavailable" },
    ]);
    expect(plan.map(({ item }) => item.id)).toEqual(items.map(({ id }) => id));
    expect(items[0]?.formats.map(({ format }) => format)).toEqual(["epub", "pdf"]);
  });
});

describe("bulk device-send planning", () => {
  test("sends only an exact attached preference and never falls back silently", () => {
    const exact = libraryItem("exact", [
      bookFormat("epub", "/Books/exact.epub"),
      bookFormat("pdf", "/Books/exact.pdf"),
    ]);
    const convertible = libraryItem("convertible", [
      bookFormat("mobi", "/Books/convertible.mobi"),
      bookFormat("epub", "/Books/convertible.epub"),
    ]);
    const unavailable = libraryItem("unavailable", [
      bookFormat("mobi", "/Books/unavailable.mobi"),
    ]);

    expect(planBulkDeviceSend([exact, convertible, unavailable], "pdf")).toEqual([
      { status: "eligible", item: exact, bookFormat: exact.formats[1] },
      {
        status: "convertible",
        item: convertible,
        source: convertible.formats[1],
        target: "pdf",
      },
      { status: "unavailable", item: unavailable, preferred: "pdf" },
    ]);
  });

  test("does not infer conversion or use another attachment for an unsupported preference", () => {
    const epub = libraryItem("epub", [bookFormat("epub", "/Books/title.epub")]);

    expect(planBulkDeviceSend([epub], "azw3")).toEqual([
      { status: "unavailable", item: epub, preferred: "azw3" },
    ]);
  });
});
