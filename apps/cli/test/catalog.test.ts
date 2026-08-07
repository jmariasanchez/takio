import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";

import { CatalogError, renderCatalog, writeCatalog } from "../src/catalog.js";
import { createProgram } from "../src/main.js";

const item: LibraryItem = {
  id: "book-1",
  title: "A <Book>",
  sourcePath: "/private/library/book.epub",
  format: "epub",
  addedAt: "2026-07-31T12:00:00.000Z",
  formats: [{
    sourcePath: "/private/library/book.epub",
    format: "epub",
    addedAt: "2026-07-31T12:00:00.000Z",
    provenance: "referenced",
  }],
  authors: [{ name: "Ada Example" }],
  identifiers: { isbn: "123" },
  customMetadata: { shelf: "Upstairs" },
  tags: ["Reference"],
};

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("catalog generation", () => {
  it("renders portable catalogs without leaking stored filesystem paths", () => {
    for (const format of ["json", "csv", "html"] as const) {
      const catalog = renderCatalog([item], format);
      expect(catalog).toContain("A");
      expect(catalog).not.toContain(item.sourcePath);
    }
    expect(renderCatalog([item], "html")).toContain("A &lt;Book&gt;");
  });

  it("keeps formula-like metadata passive in spreadsheet catalogs", () => {
    const dangerous: LibraryItem = {
      ...item,
      title: "\t=HYPERLINK(\"https://example.invalid\")",
      authors: [{ name: "\u0000@SUM(1,1)" }],
      series: "  +1+1",
      publisher: "\r-2+2",
    };

    const catalog = renderCatalog([dangerous], "csv");

    expect(catalog).toContain(`"'\t=HYPERLINK(""https://example.invalid"")"`);
    expect(catalog).toContain(`"'\u0000@SUM(1,1)"`);
    expect(catalog).toContain("'  +1+1");
    expect(catalog).toContain(`"'\r-2+2"`);
  });

  it("publishes one checksummed file and refuses replacement", async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-catalog-"));
    const outputPath = join(directory, "catalog.json");
    const written = await writeCatalog({ items: [item], format: "json", outputPath });

    expect(written).toMatchObject({ path: await realpath(outputPath), books: 1 });
    expect(written.sha256).toHaveLength(64);
    expect(JSON.parse(await Bun.file(outputPath).text())).toMatchObject({
      version: 1,
      books: [{ id: "book-1", formats: ["epub"] }],
    });
    await expect(writeCatalog({ items: [item], format: "json", outputPath })).rejects.toEqual(
      new CatalogError("output-file-exists"),
    );
  });

  it("wires catalog publication and an opt-in readable library listing into the CLI", async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-catalog-cli-"));
    const databasePath = join(directory, "library.sqlite");
    const sourcePath = join(directory, "book.epub");
    const outputPath = join(directory, "catalog.html");
    await Bun.write(sourcePath, "book");
    const invoke = async (args: string[]): Promise<string[]> => {
      const output: string[] = [];
      await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", ...args]);
      return output;
    };
    await invoke([
      "library", "add", "--db", databasePath, "--id", "book-1", "--title",
      "Human\t\u001b[31mBook\u001b]0;forged title\u0007\u009b2J",
      "--source-path", sourcePath, "--format", "epub", "--added-at",
      "2026-07-31T12:00:00.000Z",
    ]);

    expect(await invoke(["library", "list", "--db", databasePath, "--human"])).toEqual([
      "ID\tTITLE\tAUTHORS\tFORMATS",
      "book-1\tHuman [31mBook ]0;forged title 2J\t\tepub",
    ]);
    const response = JSON.parse((await invoke([
      "library", "catalog", "--db", databasePath, "--format", "html", "--output", outputPath,
    ]))[0]!) as { value: { catalog: { books: number; sha256: string } } };
    expect(response.value.catalog).toMatchObject({ books: 1 });
    expect(response.value.catalog.sha256).toHaveLength(64);
    expect(await Bun.file(outputPath).text()).toContain(
      "Human\t\u001b[31mBook\u001b]0;forged title\u0007\u009b2J",
    );
  });
});
