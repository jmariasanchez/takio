import { z } from "zod";

export const conversionSettingsV1Schema = z.object({
  version: z.literal(1),
  profileId: z.literal("default"),
}).strict().readonly();

export type ConversionSettingsV1 = z.infer<typeof conversionSettingsV1Schema>;

export const DEFAULT_CONVERSION_SETTINGS_V1: ConversionSettingsV1 =
  conversionSettingsV1Schema.parse({ version: 1, profileId: "default" });
