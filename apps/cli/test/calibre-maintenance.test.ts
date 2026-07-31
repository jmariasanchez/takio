import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MaintenanceError,
  discoverEbookPolish,
  extractEbookText,
  findLiteralText,
  polishEbook,
} from "../src/calibre-maintenance.js";

const FAKE_CONVERT = join(import.meta.dir, "fixtures/fake-ebook-convert.ts");
const FAKE_POLISH = join(import.meta.dir, "fixtures/fake-ebook-polish.ts");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takio-maintenance-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Calibre maintenance", () => {
  it("extracts bounded text and finds literal case-insensitive snippets", async () => {
    const root = await temporaryRoot();
    const source = join(root, "book.epub");
    await writeFile(source, "Alpha % marker. Another ALPHA marker.");

    const extracted = await extractEbookText({
      backendPath: FAKE_CONVERT,
      sourcePath: source,
      timeoutMs: 5_000,
    });

    expect(extracted).toEqual({
      sourcePath: await realpath(source),
      format: "epub",
      text: "Alpha % marker. Another ALPHA marker.",
    });
    expect(findLiteralText(extracted.text, "alpha")).toEqual({
      matches: 2,
      snippets: [
        "Alpha % marker. Another ALPHA marker.",
        "Alpha % marker. Another ALPHA marker.",
      ],
    });
    expect(findLiteralText(extracted.text, "%")).toMatchObject({ matches: 1 });
  });

  it("discovers and runs ebook-polish with exact operations and no overwrite", async () => {
    const root = await temporaryRoot();
    const configured = join(root, "ebook-polish");
    await writeFile(configured, await readFile(FAKE_POLISH));
    await chmod(configured, 0o700);
    expect(await discoverEbookPolish(
      { TAKIO_EBOOK_POLISH: configured },
      "linux",
      join(root, "missing"),
    )).toEqual({ ok: true, path: await realpath(configured) });

    const record = join(root, "argv.json");
    const input = join(root, "input.epub");
    const output = join(root, "output.epub");
    const inputContents = JSON.stringify({
      fakeEbookPolish: { record, mutateInput: "backend-mutated staged input" },
    });
    await writeFile(input, inputContents);
    const polished = await polishEbook({
      backendPath: configured,
      input,
      output,
      operations: ["compress-images", "remove-unused-css"],
      timeoutMs: 5_000,
    });

    expect(polished).toMatchObject({
      backend: "ebook-polish",
      inputFormat: "epub",
      operations: ["compress-images", "remove-unused-css"],
      artifact: {
        path: join(await realpath(root), "output.epub"),
        bytes: Buffer.byteLength("backend-mutated staged input"),
      },
    });
    expect((await readFile(input)).toString()).toBe(inputContents);
    expect((await readFile(output)).toString()).toBe("backend-mutated staged input");
    expect(JSON.parse((await readFile(record)).toString())).toEqual({
      argv: [
        "--compress-images",
        "--remove-unused-css",
        expect.stringContaining("takio-polish-"),
        expect.stringContaining("takio-polish-"),
      ],
    });
    await expect(polishEbook({
      backendPath: configured,
      input,
      output,
      operations: ["compress-images"],
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: "output-file-exists" } satisfies Partial<MaintenanceError>);
  });

  it("rejects unsupported and contradictory polish requests before publication", async () => {
    const root = await temporaryRoot();
    const input = join(root, "input.pdf");
    await writeFile(input, "pdf");
    await expect(polishEbook({
      backendPath: FAKE_POLISH,
      input,
      output: join(root, "output.pdf"),
      operations: ["compress-images"],
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: "unsupported-format" } satisfies Partial<MaintenanceError>);

    const epub = join(root, "input.epub");
    await writeFile(epub, "epub");
    await expect(polishEbook({
      backendPath: FAKE_POLISH,
      input: epub,
      output: join(root, "output.epub"),
      operations: ["add-soft-hyphens", "remove-soft-hyphens"],
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: "invalid-arguments" } satisfies Partial<MaintenanceError>);
  });
});
