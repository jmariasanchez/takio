#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import {
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  localDevice,
  planConversion,
  type FormatId,
} from "@takio/core";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";

function storageCommand(command: Command, write: (message: string) => void): Command {
  return command
    .configureOutput({ writeErr: () => {} })
    .exitOverride((error) => {
      const code = error.code.startsWith("commander.") ? "invalid-arguments" : error.code;
      write(JSON.stringify({ ok: false, error: { code } }));
      throw error;
    });
}

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

  const library = storageCommand(new Command("library"), write).description(
    "Manage a durable local library",
  );
  program.addCommand(library);

  storageCommand(library.command("add"), write)
    .requiredOption("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--title <title>", "library item title")
    .requiredOption("--source-path <path>", "source document path")
    .requiredOption("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--added-at <timestamp>", "ISO-8601 added timestamp")
    .action(
      async (
        options: {
          db: string;
          id: string;
          title: string;
          sourcePath: string;
          format: string;
          addedAt: string;
        },
        command: Command,
      ) => {
        if (options.db.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const store = new BunSqliteLibraryStore(options.db);
        try {
          const opened = await store.open({ config: {} });
          if (!opened.ok) {
            command.error("", { exitCode: 1, code: opened.error.code });
          }

          const result = await store.add({
            item: {
              id: options.id,
              title: options.title,
              sourcePath: options.sourcePath,
              format: options.format as FormatId,
              addedAt: options.addedAt,
            },
          });
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }

          write(JSON.stringify({ ok: true, value: { item: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(library.command("list").helpOption(false), write)
    .requiredOption("--db <path>", "database path")
    .action(async (options: { db: string }, command: Command) => {
      if (options.db.length === 0) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const store = new BunSqliteLibraryStore(options.db);
      try {
        const opened = await store.open({ config: {} });
        if (!opened.ok) {
          command.error("", { exitCode: 1, code: opened.error.code });
        }

        const result = await store.list({});
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }

        write(JSON.stringify({ ok: true, value: { items: result.value } }));
      } finally {
        store.close();
      }
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
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run(process.argv);
}
