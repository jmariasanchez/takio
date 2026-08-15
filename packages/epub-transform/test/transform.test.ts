import { describe, expect, it } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { EpubTransformError, transformEpubToKepub } from "../src/index.js";

function fixture(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "OPS/book.opf": strToU8(
      '<package><metadata><meta name="cover" content="art"/></metadata><manifest><item id="art" href="cover.jpg" media-type="image/jpeg" properties="nav"/><item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    ),
    "OPS/cover.jpg": new Uint8Array([1, 2, 3]),
    "OPS/text/chapter.xhtml": strToU8(
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title><style>.x { color: red }</style></head><body><p data-note="1 > 0">Hello world. Next sentence!</p><p><em>Marked text</em> remains.</p></body></html>',
    ),
  });
}

describe("transformEpubToKepub", () => {
  it("adds stable Kobo sentence spans to spine content", () => {
    const result = transformEpubToKepub(fixture());
    const entries = unzipSync(result.bytes);
    const chapter = strFromU8(entries["OPS/text/chapter.xhtml"]!);
    const opf = strFromU8(entries["OPS/book.opf"]!);

    expect(result.contentDocuments).toBe(1);
    expect(result.spans).toBe(4);
    expect(chapter).toContain('<span class="koboSpan" id="kobo.1.1">Hello world. </span>');
    expect(chapter).toContain('<span class="koboSpan" id="kobo.1.2">Next sentence!</span>');
    expect(chapter).toContain('<p data-note="1 > 0">');
    expect(chapter).toContain("<style>.x { color: red }</style>");
    expect(opf).toContain('properties="nav cover-image"');
    expect(entries["OPS/cover.jpg"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(strFromU8(entries.mimetype!)).toBe("application/epub+zip");
  });

  it("rejects archives without the EPUB container contract", () => {
    expect(() => transformEpubToKepub(zipSync({ file: strToU8("not an epub") }))).toThrow(
      EpubTransformError,
    );
  });

  it("rejects unsafe archive paths", () => {
    expect(() => transformEpubToKepub(zipSync({
      mimetype: strToU8("application/epub+zip"),
      "../book.opf": strToU8("bad"),
    }))).toThrow(EpubTransformError);
  });
});
