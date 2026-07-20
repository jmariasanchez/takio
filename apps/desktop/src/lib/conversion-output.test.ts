import { expect, test } from "bun:test";

import {
  createConversionOutputPath,
  type ConversionOutputDependencies,
} from "./conversion-output";

test("allocates unique PDF staging paths without a caller-chosen destination", async () => {
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const dependencies: ConversionOutputDependencies = {
    getTempDirectory: async () => "/private/tmp/takio",
    joinPath: async (directory, fileName) => `${directory}/${fileName}`,
    randomUuid: () => uuids.shift()!,
  };

  const first = await createConversionOutputPath(dependencies);
  const second = await createConversionOutputPath(dependencies);

  expect(first).toBe(
    "/private/tmp/takio/takio-conversion-11111111-1111-4111-8111-111111111111.pdf",
  );
  expect(second).toBe(
    "/private/tmp/takio/takio-conversion-22222222-2222-4222-8222-222222222222.pdf",
  );
  expect(first.startsWith("/private/tmp/takio/")).toBe(true);
  expect(second.startsWith("/private/tmp/takio/")).toBe(true);
  expect(first).not.toBe(second);
  expect(first.endsWith(".pdf")).toBe(true);
  expect(second.endsWith(".pdf")).toBe(true);
});
