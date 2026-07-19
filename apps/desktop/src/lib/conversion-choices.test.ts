import { expect, test } from "bun:test";
import type { BookFormat } from "@takio/core";

import { conversionChoices } from "./conversion-choices";

function bookFormat(format: BookFormat["format"], sourcePath: string): BookFormat {
  return {
    format,
    sourcePath,
    provenance: "referenced",
    addedAt: "2026-07-20T12:00:00.000Z",
  };
}

test("offers EPUB to PDF from a secondary format without changing format order", () => {
  const formats = [
    bookFormat("mobi", "/Books/Title.mobi"),
    bookFormat("epub", "/Books/Title.epub"),
    bookFormat("txt", "/Books/Title.txt"),
  ] as const;

  expect(conversionChoices(formats)).toEqual([
    { source: formats[1], target: "pdf" },
  ]);
  expect(formats.map(({ format }) => format)).toEqual(["mobi", "epub", "txt"]);
});

test("offers nothing when PDF is already attached, even when EPUB is secondary", () => {
  const formats = [
    bookFormat("pdf", "/Books/Title.pdf"),
    bookFormat("epub", "/Books/Title.epub"),
  ] as const;

  expect(conversionChoices(formats)).toEqual([]);
});

test("offers nothing when no verified source format is attached", () => {
  const formats = [
    bookFormat("mobi", "/Books/Title.mobi"),
    bookFormat("txt", "/Books/Title.txt"),
  ] as const;

  expect(conversionChoices(formats)).toEqual([]);
});
