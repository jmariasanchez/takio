import { expect, test } from "bun:test";
import type { BookFormat } from "@takio/core";

import { resolveDeviceFormatPreference } from "./device-format-preference";

function bookFormat(format: BookFormat["format"], sourcePath: string): BookFormat {
  return {
    format,
    sourcePath,
    provenance: "referenced",
    addedAt: "2026-07-20T12:00:00.000Z",
  };
}

test("returns the exact attached preferred format instead of the primary format", () => {
  const formats = [
    bookFormat("epub", "/Books/Title.epub"),
    bookFormat("pdf", "/Books/Title.pdf"),
  ] as const;

  const result = resolveDeviceFormatPreference(formats, "pdf");

  expect(result).toEqual({ kind: "attached", bookFormat: formats[1] });
  if (result.kind === "attached") {
    expect(result.bookFormat).toBe(formats[1]);
  }
});

test("prefers an attached format over converting another attachment", () => {
  const formats = [
    bookFormat("pdf", "/Books/Title.pdf"),
    bookFormat("epub", "/Books/Title.epub"),
  ] as const;

  expect(resolveDeviceFormatPreference(formats, "pdf")).toEqual({
    kind: "attached",
    bookFormat: formats[0],
  });
});

test("returns the exact EPUB source when the preferred PDF is convertible", () => {
  const formats = [
    bookFormat("mobi", "/Books/Title.mobi"),
    bookFormat("epub", "/Books/Title.epub"),
  ] as const;

  const result = resolveDeviceFormatPreference(formats, "pdf");

  expect(result).toEqual({
    kind: "convertible",
    source: formats[1],
    target: "pdf",
  });
  if (result.kind === "convertible") {
    expect(result.source).toBe(formats[1]);
  }
});

test("does not infer an unsupported conversion for another preferred format", () => {
  const formats = [bookFormat("epub", "/Books/Title.epub")] as const;

  expect(resolveDeviceFormatPreference(formats, "azw3")).toEqual({
    kind: "unavailable",
    preferred: "azw3",
  });
});

test("returns unavailable rather than falling back to an attached format", () => {
  const formats = [bookFormat("mobi", "/Books/Title.mobi")] as const;

  expect(resolveDeviceFormatPreference(formats, "pdf")).toEqual({
    kind: "unavailable",
    preferred: "pdf",
  });
});
