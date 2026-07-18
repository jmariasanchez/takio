#!/usr/bin/env bun
import { Command } from "commander";
import {
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  localDevice,
  planConversion,
  type FormatId,
} from "@takio/core";

export function createProgram(write: (message: string) => void = console.log): Command {
  const program = new Command();

  program
    .name("takio")
    .description("Plan document conversions across connected Takio devices")
    .version("0.1.0");

  program
    .command("formats")
    .description("List the built-in format catalogue")
    .option("--json", "emit JSON instead of a table")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        write(JSON.stringify(FORMAT_CATALOG, null, 2));
        return;
      }
      write("FORMAT  KIND      EXTENSIONS");
      for (const format of FORMAT_CATALOG) {
        write(`${format.id.padEnd(7)} ${format.kind.padEnd(9)} ${format.extensions.join(", ")}`);
      }
    });

  program
    .command("devices")
    .description("List devices known to this Takio controller")
    .action(() => {
      write("ID     STATUS  NAME      OUTPUTS");
      write(
        `${localDevice.id.padEnd(6)} ${localDevice.status.padEnd(7)} ${localDevice.name.padEnd(9)} ${localDevice.supportedOutputs.join(", ")}`,
      );
    });

  program
    .command("plan")
    .description("Create a conversion plan; execution adapters will be added next")
    .requiredOption("--input <path>", "source document path")
    .requiredOption("--to <format>", `target format: ${FORMAT_IDS.join(", ")}`)
    .option("--json", "emit JSON instead of a readable summary")
    .action((options: { input: string; to: string; json?: boolean }) => {
      try {
        const job = planConversion({
          input: options.input,
          outputFormat: options.to as FormatId,
          devices: [localDevice],
        });
        if (options.json) {
          write(JSON.stringify(job, null, 2));
          return;
        }
        write(`Planned ${job.id}`);
        write(`  ${job.inputFormat.toUpperCase()} → ${job.outputFormat.toUpperCase()}`);
        write(`  device: ${job.assignedDevice.name} (${job.assignedDevice.id})`);
        write("  status: planned (no converter adapter is configured yet)");
      } catch (error) {
        if (error instanceof PlanningError) {
          program.error(error.message, { exitCode: 2 });
        }
        throw error;
      }
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run(process.argv);
}
