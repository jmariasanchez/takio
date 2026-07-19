import type { BookFormat, FormatId } from "@takio/core";

export type ConversionChoice = {
  readonly source: BookFormat;
  readonly target: FormatId;
};

export function conversionChoices(
  formats: readonly BookFormat[],
): readonly ConversionChoice[] {
  if (formats.some((bookFormat) => bookFormat.format === "pdf")) {
    return [];
  }

  return formats
    .filter((bookFormat) => bookFormat.format === "epub")
    .map((source) => ({ source, target: "pdf" }));
}
