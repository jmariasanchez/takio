import { describe, expect, test } from "bun:test";
import {
  classifyDestinationKind,
  defaultDestinationSubdir,
  sanitizeDestinationFileName,
} from "../src/index";

describe("destination helpers", () => {
  test("classifies marker directories without depending on their casing", () => {
    expect(classifyDestinationKind(["documents", "system"])).toBe("kindle");
    expect(classifyDestinationKind(["Documents", "System"])).toBe("kindle");
    expect(classifyDestinationKind([".kobo"])).toBe("kobo");
    expect(classifyDestinationKind(["Books"])).toBe("generic");
  });

  test("uses the device-specific default transfer directory", () => {
    expect(defaultDestinationSubdir("kindle")).toBe("documents");
    expect(defaultDestinationSubdir("kobo")).toBe("");
    expect(defaultDestinationSubdir("generic")).toBe("");
  });

  test("turns traversal-shaped names into contained FAT-safe basenames", () => {
    expect(sanitizeDestinationFileName("../../unsafe:<title>?.epub")).toBe(
      "unsafetitle.epub",
    );
    expect(sanitizeDestinationFileName("..\\folder\\book*.pdf")).toBe(
      "book.pdf",
    );
    expect(sanitizeDestinationFileName("chapter\u0000one.epub")).toBe(
      "chapterone.epub",
    );
  });

  test("rejects names that cannot identify a destination file", () => {
    for (const name of ["", ".", "..", "<>:\"|?*\u0000"]) {
      expect(sanitizeDestinationFileName(name)).toBeNull();
    }
  });
});
