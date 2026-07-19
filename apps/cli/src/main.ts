#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  detectFormat,
  localDevice,
  planConversion,
  type FormatId,
} from "@takio/core";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";
import {
  DestinationTransferError,
  authorizeDestination,
  ejectDestination,
  listDestinations,
  sendToDestination,
} from "./destinations.js";

type LibraryPaths = {
  readonly databasePath: string;
  readonly itemsDirectory: string;
};

type Launcher = (argv: readonly string[]) => void | Promise<void>;
type Ejector = (destinationPath: string) => Promise<number>;

function openWithDefaultApp(argv: readonly string[]): void {
  Bun.spawn({ cmd: [...argv], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

function defaultAppCommand(sourcePath: string): readonly string[] {
  return [
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open",
    sourcePath,
  ];
}

function libraryPaths(databasePath?: string): LibraryPaths {
  if (databasePath === "") {
    throw new TypeError("A database path is required.");
  }

  if (databasePath) {
    const resolvedDatabasePath = resolve(databasePath);
    return {
      databasePath: resolvedDatabasePath,
      itemsDirectory: join(dirname(resolvedDatabasePath), "items"),
    };
  }

  const override = process.env.TAKIO_DATA_DIR;
  if (override === "") {
    throw new TypeError("TAKIO_DATA_DIR must not be empty.");
  }

  const root =
    override ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Takio")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Takio")
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "takio"));

  const resolvedRoot = resolve(root);
  return {
    databasePath: join(resolvedRoot, "library.sqlite"),
    itemsDirectory: join(resolvedRoot, "items"),
  };
}

async function openLibraryStore(
  databasePath: string | undefined,
  command: Command,
): Promise<{ store: BunSqliteLibraryStore; paths: LibraryPaths }> {
  let paths: LibraryPaths;
  try {
    paths = libraryPaths(databasePath);
  } catch {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }

  try {
    await mkdir(dirname(paths.databasePath), { recursive: true });
  } catch {
    command.error("", { exitCode: 1, code: "storage-unavailable" });
  }

  const store = new BunSqliteLibraryStore(paths.databasePath);
  const opened = await store.open({ config: {} });
  if (!opened.ok) {
    store.close();
    command.error("", { exitCode: 1, code: opened.error.code });
  }

  return { store, paths };
}

function isInside(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function removeOwnedFile(sourcePath: string, itemsDirectory: string): Promise<void> {
  const resolvedSourcePath = resolve(sourcePath);
  if (!isInside(itemsDirectory, resolvedSourcePath)) {
    return;
  }

  const [canonicalItemsDirectory, canonicalSourcePath] = await Promise.all([
    realpath(itemsDirectory),
    realpath(resolvedSourcePath),
  ]);
  if (isInside(canonicalItemsDirectory, canonicalSourcePath)) {
    await rm(resolvedSourcePath);
  }
}

function storageCommand(command: Command, write: (message: string) => void): Command {
  return command
    .configureOutput({ writeErr: () => {} })
    .exitOverride((error) => {
      const code = error.code.startsWith("commander.") ? "invalid-arguments" : error.code;
      if (error.code !== "commander.help" || command.parent?.args[0] !== "help") {
        write(JSON.stringify({ ok: false, error: { code } }));
      }
      throw error;
    });
}

export function createProgram(
  write: (message: string) => void = console.log,
  writeError: (message: string) => void = write,
  launch: Launcher = openWithDefaultApp,
  eject: Ejector = ejectDestination,
  platform: NodeJS.Platform = process.platform,
): Command {
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

  const destination = storageCommand(new Command("destination"), writeError)
    .helpOption(false)
    .addHelpCommand(false)
    .description("Manage mounted document destinations");
  program.addCommand(destination);

  storageCommand(destination.command("list").helpOption(false), writeError)
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes")
    .action(async (options: { volumesRoot: string }, command: Command) => {
      try {
        const destinations = await listDestinations(options.volumesRoot);
        write(JSON.stringify({ ok: true, value: { destinations } }));
      } catch {
        command.error("", { exitCode: 1, code: "destination-unavailable" });
      }
    });

  storageCommand(destination.command("eject").helpOption(false), writeError)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes")
    .action(
      async (
        options: { dest: string; volumesRoot: string },
        command: Command,
      ) => {
        const mountedDestination = await authorizeDestination(
          options.dest,
          options.volumesRoot,
        );
        if (!mountedDestination) {
          command.error("", { exitCode: 1, code: "unknown-destination" });
        }
        if (platform !== "darwin") {
          command.error("", { exitCode: 1, code: "unsupported-platform" });
        }

        let exitCode: number;
        try {
          exitCode = await eject(mountedDestination.path);
        } catch {
          command.error("", { exitCode: 1, code: "eject-failed" });
        }
        if (exitCode !== 0) {
          command.error("", { exitCode: 1, code: "eject-failed" });
        }
        write(
          JSON.stringify({
            ok: true,
            value: { destinationId: mountedDestination.id },
          }),
        );
      },
    );

  const send = storageCommand(new Command("send"), writeError)
    .helpOption(false)
    .description("Send a library item to a mounted destination")
    .requiredOption("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--subdir <dir>", "destination subdirectory")
    .option("--overwrite", "replace an existing destination file")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes");
  program.addCommand(send);

  send.action(
    async (
      options: {
        db: string;
        id: string;
        dest: string;
        subdir?: string;
        overwrite?: boolean;
        volumesRoot: string;
      },
      command: Command,
    ) => {
      const destination = await authorizeDestination(options.dest, options.volumesRoot);
      if (!destination) {
        command.error("", { exitCode: 1, code: "unknown-destination" });
      }

      const { store } = await openLibraryStore(options.db, command);
      try {
        const item = await store.get({ id: options.id });
        if (!item.ok) {
          command.error("", { exitCode: 1, code: item.error.code });
        }
        if (!item.value) {
          command.error("", { exitCode: 1, code: "unknown-item" });
        }

        try {
          const result = await sendToDestination({
            itemId: item.value.id,
            sourcePath: item.value.sourcePath,
            destination,
            subdir: options.subdir,
            overwrite: options.overwrite,
          });
          write(JSON.stringify({ ok: true, value: result }));
        } catch (error) {
          if (error instanceof DestinationTransferError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          throw error;
        }
      } finally {
        store.close();
      }
    },
  );

  const library = storageCommand(new Command("library"), writeError)
    .helpOption(false)
    .addHelpCommand(false)
    .description("Manage a durable local library");
  program.addCommand(library);

  storageCommand(library.command("add").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--title <title>", "library item title")
    .requiredOption("--source-path <path>", "source document path")
    .requiredOption("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--added-at <timestamp>", "ISO-8601 added timestamp")
    .action(
      async (
        options: {
          db?: string;
          id: string;
          title: string;
          sourcePath: string;
          format: string;
          addedAt: string;
        },
        command: Command,
      ) => {
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.add({
            item: {
              id: options.id,
              title: options.title,
              sourcePath: options.sourcePath,
              format: options.format as FormatId,
              addedAt: options.addedAt,
              tags: [],
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

  storageCommand(library.command("list").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .action(async (options: { db?: string }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.list({});
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }

        write(JSON.stringify({ ok: true, value: { items: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("import").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--source-path <path>", "source document path")
    .option("--title <title>", "library item title")
    .action(
      async (
        options: { db?: string; sourcePath: string; title?: string },
        command: Command,
      ) => {
        let sourcePath: string;
        const format = detectFormat(options.sourcePath);
        try {
          const source = await stat(options.sourcePath);
          if (!source.isFile() || !format) {
            command.error("", { exitCode: 1, code: "invalid-arguments" });
          }
          sourcePath = await realpath(options.sourcePath);
        } catch (error) {
          if (error instanceof CommanderError) {
            throw error;
          }
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store, paths } = await openLibraryStore(options.db, command);
        const id = `item_${crypto.randomUUID()}`;
        const extension = extname(sourcePath).toLowerCase();
        const item = {
          id,
          title: options.title ?? basename(sourcePath, extname(sourcePath)),
          sourcePath: join(paths.itemsDirectory, `${id}${extension}`),
          format: format!,
          addedAt: new Date().toISOString(),
          tags: [],
        };
        const temporaryPath = `${item.sourcePath}.tmp-${crypto.randomUUID()}`;
        let committed = false;
        let failureCode: string | undefined;

        try {
          await mkdir(paths.itemsDirectory, { recursive: true });
          await copyFile(sourcePath, temporaryPath);
          await rename(temporaryPath, item.sourcePath);

          const result = await store.add({ item });
          if (!result.ok) {
            failureCode = result.error.code;
          } else {
            committed = true;
            write(JSON.stringify({ ok: true, value: { item: result.value } }));
          }
        } catch {
          failureCode = "storage-unavailable";
        } finally {
          if (!committed) {
            const cleanup = await Promise.allSettled([
              rm(temporaryPath, { force: true }),
              rm(item.sourcePath, { force: true }),
            ]);
            if (cleanup.some((result) => result.status === "rejected")) {
              failureCode = "storage-unavailable";
            }
          }
          store.close();
        }

        if (failureCode) {
          command.error("", { exitCode: 1, code: failureCode });
        }
      },
    );

  storageCommand(library.command("get").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id.length === 0) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.get({ id: options.id });
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }
        write(JSON.stringify({ ok: true, value: { item: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("open").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--json", "emit JSON instead of a readable confirmation")
    .action(
      async (
        options: { db?: string; id: string; json?: boolean },
        command: Command,
      ) => {
        if (options.id.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.get({ id: options.id });
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          const item = result.value;
          if (!item) {
            command.error("", { exitCode: 1, code: "not-found" });
          }

          try {
            if (!(await stat(item.sourcePath)).isFile()) {
              command.error("", { exitCode: 1, code: "missing-file" });
            }
          } catch (error) {
            if (error instanceof CommanderError) {
              throw error;
            }
            command.error("", { exitCode: 1, code: "missing-file" });
          }

          const declaredFormat = FORMAT_CATALOG.find(
            (format) => format.id === item.format,
          );
          if (
            !declaredFormat?.extensions.includes(extname(item.sourcePath).toLowerCase())
          ) {
            command.error("", { exitCode: 1, code: "format-mismatch" });
          }

          try {
            await launch(defaultAppCommand(item.sourcePath));
          } catch {
            command.error("", { exitCode: 1, code: "open-failed" });
          }

          write(
            options.json
              ? JSON.stringify({
                  ok: true,
                  value: { id: item.id, path: item.sourcePath },
                })
              : `Opened ${item.sourcePath}`,
          );
        } finally {
          store.close();
        }
      },
    );

  storageCommand(library.command("update").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--title <title>", "replacement title")
    .option("--author <author>", "replacement author; empty clears it")
    .option("--description <description>", "replacement description; empty clears it")
    .option(
      "--tag <tag>",
      "replacement tag (repeatable; omitted clears all tags)",
      (tag: string, tags: string[]) => [...tags, tag],
      [],
    )
    .action(
      async (
        options: {
          db?: string;
          id: string;
          title?: string;
          author?: string;
          description?: string;
          tag: string[];
        },
        command: Command,
      ) => {
        if (options.id.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.update({
            id: options.id,
            patch: {
              title: options.title,
              author:
                options.author === undefined
                  ? undefined
                  : options.author.trim() === ""
                    ? null
                    : options.author,
              description:
                options.description === undefined
                  ? undefined
                  : options.description.trim() === ""
                    ? null
                    : options.description,
              tags: options.tag,
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

  storageCommand(library.command("search").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--query <query>", "title, author, description, or tag query")
    .action(async (options: { db?: string; query: string }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.search({ query: options.query });
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }
        write(JSON.stringify({ ok: true, value: { items: result.value } }));
      } finally {
        store.close();
      }
    });

  const cover = storageCommand(library.command("cover"), writeError)
    .helpOption(false)
    .addHelpCommand(false)
    .description("Manage an item's owned cover image");

  storageCommand(cover.command("set").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--source-path <path>", "source image path")
    .action(
      async (
        options: { db?: string; id: string; sourcePath: string },
        command: Command,
      ) => {
        if (options.id.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        let sourcePath: string;
        try {
          const source = await stat(options.sourcePath);
          if (!source.isFile()) {
            command.error("", { exitCode: 1, code: "invalid-arguments" });
          }
          sourcePath = await realpath(options.sourcePath);
        } catch (error) {
          if (error instanceof CommanderError) {
            throw error;
          }
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.setCover({ id: options.id, sourcePath });
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: { item: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(cover.command("remove").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id.length === 0) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.removeCover({ id: options.id });
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }
        write(JSON.stringify({ ok: true, value: { item: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("remove").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id.length === 0) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const { store, paths } = await openLibraryStore(options.db, command);
      try {
        const result = await store.remove({ id: options.id });
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }

        if (result.value) {
          try {
            await removeOwnedFile(result.value.sourcePath, paths.itemsDirectory);
          } catch {
            command.error("", { exitCode: 1, code: "storage-unavailable" });
          }
        }

        write(JSON.stringify({ ok: true, value: { item: result.value } }));
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
    await createProgram(console.log, (message) => process.stdout.write(message)).parseAsync(argv);
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
