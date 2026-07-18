import { expect, test } from "bun:test";

import { formatFileSize } from "./format";

test("formats byte counts for the desktop interface", () => {
  expect(formatFileSize(843)).toBe("843 B");
  expect(formatFileSize(1_536)).toBe("1.5 KB");
  expect(formatFileSize(2_621_440)).toBe("2.5 MB");
});
