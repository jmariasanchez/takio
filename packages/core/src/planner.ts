import { z } from "zod";

import { FORMAT_IDS, detectFormat, type FormatId } from "./formats.js";

const formatSchema = z.enum(FORMAT_IDS);

export const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  supportedOutputs: z.array(formatSchema).min(1),
  status: z.enum(["online", "offline"]),
});

export type Device = z.infer<typeof deviceSchema>;

export const conversionRequestSchema = z.object({
  input: z.string().min(1),
  outputFormat: formatSchema,
  devices: z.array(deviceSchema).default([]),
});

export type ConversionRequest = z.input<typeof conversionRequestSchema>;

export interface PlannedJob {
  id: string;
  input: string;
  inputFormat: FormatId;
  outputFormat: FormatId;
  assignedDevice: Pick<Device, "id" | "name">;
  status: "planned";
}

export class PlanningError extends Error {
  override name = "PlanningError";
}

export function planConversion(request: ConversionRequest): PlannedJob {
  const parsed = conversionRequestSchema.parse(request);
  const inputFormat = detectFormat(parsed.input);

  if (!inputFormat) {
    throw new PlanningError(
      `Takio cannot identify the input format for '${parsed.input}'. Use a supported file extension.`,
    );
  }

  if (inputFormat === parsed.outputFormat) {
    throw new PlanningError("Input and output formats must be different.");
  }

  const assignedDevice = parsed.devices.find(
    (device) =>
      device.status === "online" && device.supportedOutputs.includes(parsed.outputFormat),
  );

  if (!assignedDevice) {
    throw new PlanningError(
      `No online device can produce ${parsed.outputFormat.toUpperCase()}.`,
    );
  }

  return {
    id: `job_${crypto.randomUUID()}`,
    input: parsed.input,
    inputFormat,
    outputFormat: parsed.outputFormat,
    assignedDevice: { id: assignedDevice.id, name: assignedDevice.name },
    status: "planned",
  };
}

export const localDevice: Device = {
  id: "local",
  name: "This Mac",
  supportedOutputs: [...FORMAT_IDS],
  status: "online",
};
