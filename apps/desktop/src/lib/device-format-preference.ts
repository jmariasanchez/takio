import type { BookFormat, FormatId } from "@takio/core";

import { conversionChoices } from "./conversion-choices";

export type DeviceFormatPreference =
  | {
      readonly kind: "attached";
      readonly bookFormat: BookFormat;
    }
  | {
      readonly kind: "convertible";
      readonly source: BookFormat;
      readonly target: FormatId;
    }
  | {
      readonly kind: "unavailable";
      readonly preferred: FormatId;
    };

export function resolveDeviceFormatPreference(
  formats: readonly BookFormat[],
  preferred: FormatId,
): DeviceFormatPreference {
  const attached = formats.find((bookFormat) => bookFormat.format === preferred);
  if (attached) {
    return { kind: "attached", bookFormat: attached };
  }

  const conversion = conversionChoices(formats).find(
    (choice) => choice.target === preferred,
  );
  if (conversion) {
    return {
      kind: "convertible",
      source: conversion.source,
      target: conversion.target,
    };
  }

  return { kind: "unavailable", preferred };
}
