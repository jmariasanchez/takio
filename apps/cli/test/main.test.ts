import { describe, expect, it } from "bun:test";

import { createProgram } from "../src/main.js";

describe("takio CLI", () => {
  it("lists the built-in format catalogue", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", "formats"]);

    expect(output[0]).toContain("FORMAT");
    expect(output.some((line) => line.startsWith("epub"))).toBe(true);
  });

  it("plans a conversion with the local device", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync([
      "bun",
      "takio",
      "plan",
      "--input",
      "book.epub",
      "--to",
      "pdf",
    ]);

    expect(output[0]).toStartWith("Planned job_");
    expect(output).toContain("  EPUB → PDF");
  });
});
