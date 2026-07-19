import { z } from "zod";

import { FORMAT_IDS, detectFormat, type FormatId } from "./formats.js";

const formatSchema = z.enum(FORMAT_IDS);

export const conversionCapabilitySchema = z.object({
  from: formatSchema,
  to: formatSchema,
});

export type ConversionCapability = z.infer<typeof conversionCapabilitySchema>;

export const executionTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.array(conversionCapabilitySchema),
  status: z.enum(["online", "offline"]),
});

export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const conversionRequestSchema = z.object({
  input: z.string().min(1),
  outputFormat: formatSchema,
  targets: z.array(executionTargetSchema).default([]),
});

export type ConversionRequest = z.input<typeof conversionRequestSchema>;

export interface PlannedJob {
  id: string;
  input: string;
  inputFormat: FormatId;
  outputFormat: FormatId;
  assignedTarget: Pick<ExecutionTarget, "id" | "name">;
  status: "planned";
}

export class PlanningError extends Error {
  override name = "PlanningError";
}

export function planConversion(request: ConversionRequest): PlannedJob {
  const result = conversionRequestSchema.safeParse(request);
  if (!result.success) {
    throw new PlanningError("Invalid conversion request.");
  }
  const parsed = result.data;
  const inputFormat = detectFormat(parsed.input);

  if (!inputFormat) {
    throw new PlanningError(
      `Takio cannot identify the input format for '${parsed.input}'. Use a supported file extension.`,
    );
  }

  if (inputFormat === parsed.outputFormat) {
    throw new PlanningError("Input and output formats must be different.");
  }

  const assignedTarget = parsed.targets.find(
    (target) =>
      target.status === "online" &&
      target.capabilities.some(
        (capability) =>
          capability.from === inputFormat && capability.to === parsed.outputFormat,
      ),
  );

  if (!assignedTarget) {
    throw new PlanningError(
      `No online execution target can convert ${inputFormat.toUpperCase()} → ${parsed.outputFormat.toUpperCase()}.`,
    );
  }

  return {
    id: `job_${crypto.randomUUID()}`,
    input: parsed.input,
    inputFormat,
    outputFormat: parsed.outputFormat,
    assignedTarget: { id: assignedTarget.id, name: assignedTarget.name },
    status: "planned",
  };
}
