#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  detectFormat,
  planConversion,
  type FormatId,
} from "@takio/core";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";
import {
  ConversionError,
  LOCAL_CONVERSION_CAPABILITIES,
  convertLocal,
  discoverEbookConvert,
  type EbookConvertDiscovery,
} from "./convert.js";
import {
  DestinationTransferError,
  authorizeDestination,
  ejectDestination,
  listDestinations,
  sendToDestination,
} from "./destinations.js";
import { reconcileJobAttachment } from "./job-attachment.js";
import { JOB_STATUSES, JobStore, type ConversionJob, type JobStatus } from "./job-store.js";

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

function jobsDatabasePath(databasePath?: string): string {
  if (databasePath === "") {
    throw new TypeError("A database path is required.");
  }
  return databasePath
    ? resolve(databasePath)
    : join(dirname(libraryPaths().databasePath), "jobs.sqlite");
}

async function openJobStore(databasePath: string | undefined, command: Command): Promise<JobStore> {
  let path: string;
  try {
    path = jobsDatabasePath(databasePath);
  } catch {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    command.error("", { exitCode: 1, code: "storage-unavailable" });
  }
  const store = new JobStore(path);
  const opened = store.open();
  if (!opened.ok) {
    store.close();
    command.error("", { exitCode: 1, code: opened.error.code });
  }
  return store;
}

async function queuedConversionPaths(input: string, output: string, outputFormat: string): Promise<{
  inputPath: string;
  inputFormat: FormatId;
  outputPath: string;
  outputFormat: FormatId;
}> {
  if (input === "" || output === "" || !FORMAT_IDS.includes(outputFormat as FormatId)) {
    throw new ConversionError("invalid-arguments");
  }
  const inputFormat = detectFormat(input);
  if (!inputFormat || !LOCAL_CONVERSION_CAPABILITIES.some(
    (capability) => capability.from === inputFormat && capability.to === outputFormat,
  )) {
    throw new ConversionError("unsupported-conversion");
  }

  let inputPath: string;
  try {
    inputPath = await realpath(resolve(input));
    const source = await stat(inputPath);
    if (!source.isFile() || source.size === 0) {
      throw new ConversionError("source-unavailable");
    }
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError("source-unavailable");
  }

  const definition = FORMAT_CATALOG.find((format) => format.id === outputFormat)!;
  const requestedOutput = resolve(output);
  if (!definition.extensions.includes(extname(requestedOutput).toLowerCase())) {
    throw new ConversionError("invalid-arguments");
  }
  try {
    const parent = await realpath(dirname(requestedOutput));
    if (!(await stat(parent)).isDirectory()) {
      throw new ConversionError("invalid-arguments");
    }
    const outputPath = join(parent, basename(requestedOutput));
    try {
      await lstat(outputPath);
      throw new ConversionError("output-file-exists");
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConversionError("invalid-arguments");
      }
    }
    return {
      inputPath,
      inputFormat,
      outputPath,
      outputFormat: outputFormat as FormatId,
    };
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new ConversionError("invalid-arguments");
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
  conversionBackend: EbookConvertDiscovery = {
    ok: false,
    code: "backend-unavailable",
  },
): Command {
  const program = new Command();
  const localCapabilities = conversionBackend.ok
    ? LOCAL_CONVERSION_CAPABILITIES
    : [];
  const localTarget = {
    id: "local",
    name: "This Mac",
    capabilities: [...localCapabilities],
    status: "online" as const,
  };

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
      const conversions = localTarget.capabilities.length
        ? localTarget.capabilities
            .map((capability) => `${capability.from}→${capability.to}`)
            .join(", ")
        : "(none)";
      write("ID     STATUS  NAME      CONVERSIONS");
      write(
        `${localTarget.id.padEnd(6)} ${localTarget.status.padEnd(7)} ${localTarget.name.padEnd(9)} ${conversions}`,
      );
    });

  const convert = storageCommand(new Command("convert"), writeError)
    .helpOption(false)
    .description("Convert a local document with Calibre ebook-convert")
    .requiredOption("--input <path>", "source document path")
    .requiredOption("--to <format>", `target format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--output <path>", "output artifact path")
    .option("--timeout-seconds <seconds>", "conversion timeout", "300");
  program.addCommand(convert);

  convert.action(
    async (
      options: {
        input: string;
        to: string;
        output: string;
        timeoutSeconds: string;
      },
      command: Command,
    ) => {
      const timeoutSeconds = Number(options.timeoutSeconds);
      if (
        !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > Math.floor(2_147_483_647 / 1000)
      ) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      if (!conversionBackend.ok) {
        command.error("", { exitCode: 1, code: conversionBackend.code });
      }

      try {
        const job = await convertLocal({
          backendPath: conversionBackend.path,
          input: options.input,
          output: options.output,
          outputFormat: options.to,
          timeoutMs: timeoutSeconds * 1000,
        });
        write(JSON.stringify({ ok: true, value: { job } }));
      } catch (error) {
        if (error instanceof ConversionError) {
          command.error("", { exitCode: 1, code: error.code });
        }
        throw error;
      }
    },
  );

  const jobs = storageCommand(new Command("jobs"), writeError)
    .helpOption(false)
    .addHelpCommand(false)
    .description("Manage durable foreground conversion jobs");
  program.addCommand(jobs);

  storageCommand(jobs.command("enqueue").helpOption(false), writeError)
    .option("--db <path>", "jobs database path")
    .option("--input <path>", "source document path")
    .option("--library-item-id <id>", "library item ID")
    .option("--from <format>", `source library format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--to <format>", `target format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--output <path>", "output artifact path")
    .action(async (
      options: {
        db?: string;
        input?: string;
        libraryItemId?: string;
        from?: string;
        to: string;
        output: string;
      },
      command: Command,
    ) => {
      const pathSource = options.input !== undefined &&
        options.libraryItemId === undefined && options.from === undefined;
      const librarySource = options.input === undefined &&
        options.libraryItemId !== undefined && options.from !== undefined;
      if (!pathSource && !librarySource) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      let queued;
      if (pathSource) {
        try {
          queued = await queuedConversionPaths(options.input!, options.output, options.to);
        } catch (error) {
          if (error instanceof ConversionError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          throw error;
        }
      } else {
        if (
          options.db !== undefined || options.libraryItemId!.length === 0 ||
          !FORMAT_IDS.includes(options.from as FormatId) ||
          !FORMAT_IDS.includes(options.to as FormatId)
        ) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store: libraryStore } = await openLibraryStore(undefined, command);
        try {
          const found = await libraryStore.get({ id: options.libraryItemId! });
          if (!found.ok) {
            command.error("", { exitCode: 1, code: found.error.code });
          }
          if (!found.value) {
            command.error("", { exitCode: 1, code: "not-found" });
          }
          const source = found.value.formats.find(({ format }) => format === options.from);
          if (!source) {
            command.error("", { exitCode: 1, code: "format-not-found" });
          }
          if (!LOCAL_CONVERSION_CAPABILITIES.some(
            ({ from, to }) => from === options.from && to === options.to,
          )) {
            command.error("", { exitCode: 1, code: "unsupported-conversion" });
          }
          if (found.value.formats.some(({ format }) => format === options.to)) {
            command.error("", { exitCode: 1, code: "duplicate-format" });
          }
          if (detectFormat(source.sourcePath) !== options.from) {
            command.error("", { exitCode: 1, code: "format-mismatch" });
          }

          try {
            queued = {
              ...(await queuedConversionPaths(source.sourcePath, options.output, options.to)),
              libraryItemId: options.libraryItemId!,
            };
          } catch (error) {
            if (error instanceof ConversionError) {
              command.error("", { exitCode: 1, code: error.code });
            }
            throw error;
          }
        } finally {
          libraryStore.close();
        }
      }

      const store = await openJobStore(options.db, command);
      try {
        const result = store.enqueue(queued);
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { job: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("list").helpOption(false), writeError)
    .option("--db <path>", "jobs database path")
    .option("--status <status>", `job status: ${JOB_STATUSES.join(", ")}`)
    .action(async (options: { db?: string; status?: string }, command: Command) => {
      if (options.status && !JOB_STATUSES.includes(options.status as JobStatus)) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      const store = await openJobStore(options.db, command);
      try {
        const result = store.list(options.status as JobStatus | undefined);
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { jobs: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("get").helpOption(false), writeError)
    .option("--db <path>", "jobs database path")
    .requiredOption("--id <id>", "job ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id === "") command.error("", { exitCode: 1, code: "invalid-arguments" });
      const store = await openJobStore(options.db, command);
      try {
        const result = store.get(options.id);
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { job: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("cancel").helpOption(false), writeError)
    .option("--db <path>", "jobs database path")
    .requiredOption("--id <id>", "job ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id === "") command.error("", { exitCode: 1, code: "invalid-arguments" });
      const store = await openJobStore(options.db, command);
      try {
        const result = store.cancel(options.id);
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { job: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("run-next").helpOption(false), writeError)
    .option("--db <path>", "jobs database path")
    .action(async (options: { db?: string }, command: Command) => {
      const store = await openJobStore(options.db, command);
      try {
        const reconcileClaimedAttachment = async (job: ConversionJob): Promise<ConversionJob> => {
          if (options.db !== undefined) {
            const released = store.releaseAttachmentClaim(job.id);
            if (!released.ok) {
              command.error("", { exitCode: 1, code: released.error.code });
            }
            command.error("", { exitCode: 1, code: "invalid-arguments" });
          }

          const { store: libraryStore } = await openLibraryStore(undefined, command);
          try {
            const reconciled = await reconcileJobAttachment(store, libraryStore, job);
            if (!reconciled.ok) {
              command.error("", { exitCode: 1, code: reconciled.error.code });
            }
            return reconciled.value;
          } finally {
            libraryStore.close();
          }
        };

        const pendingAttachment = store.claimNextPendingAttachment();
        if (!pendingAttachment.ok) {
          command.error("", { exitCode: 1, code: pendingAttachment.error.code });
        }
        if (pendingAttachment.value) {
          const job = await reconcileClaimedAttachment(pendingAttachment.value);
          write(JSON.stringify({ ok: true, value: { job } }));
          return;
        }

        if (!conversionBackend.ok) {
          command.error("", { exitCode: 1, code: conversionBackend.code });
        }
        const claimed = store.claimNext();
        if (!claimed.ok) command.error("", { exitCode: 1, code: claimed.error.code });
        if (!claimed.value) {
          write(JSON.stringify({ ok: true, value: { job: null } }));
          return;
        }

        let result: { ok: true; value: ConversionJob } | { ok: false; error: { code: string } } | undefined;
        let converted: Awaited<ReturnType<typeof convertLocal>> | undefined;
        try {
          converted = await convertLocal({
            backendPath: conversionBackend.path,
            input: claimed.value.inputPath,
            output: claimed.value.outputPath,
            outputFormat: claimed.value.outputFormat,
            timeoutMs: 300_000,
          });
        } catch (error) {
          result = store.fail(
            claimed.value.id,
            error instanceof ConversionError ? error.code : "conversion-failed",
          );
        }
        if (converted) {
          const completed = await store.complete(claimed.value.id, {
            path: converted.artifact.path,
            bytes: converted.artifact.bytes,
            sha256: converted.artifact.sha256,
          });
          if (!completed.ok && completed.error.code === "artifact-invalid") {
            result = store.fail(claimed.value.id, "artifact-invalid");
          } else if (completed.ok && completed.value.attachment?.status === "pending") {
            const pending = store.claimNextPendingAttachment();
            if (!pending.ok) {
              command.error("", { exitCode: 1, code: pending.error.code });
            }
            if (!pending.value || pending.value.id !== completed.value.id) {
              if (pending.value) {
                const released = store.releaseAttachmentClaim(pending.value.id);
                if (!released.ok) {
                  command.error("", { exitCode: 1, code: released.error.code });
                }
              }
              result = completed;
            } else {
              result = {
                ok: true,
                value: await reconcileClaimedAttachment(pending.value),
              };
            }
          } else {
            result = completed;
          }
        }
        if (!result) throw new Error("Conversion finished without a durable job result.");
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { job: result.value } }));
      } finally {
        store.close();
      }
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
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--subdir <dir>", "destination subdirectory")
    .option("--overwrite", "replace an existing destination file")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes");
  program.addCommand(send);

  send.action(
    async (
      options: {
        db?: string;
        id: string;
        format?: string;
        dest: string;
        subdir?: string;
        overwrite?: boolean;
        volumesRoot: string;
      },
      command: Command,
    ) => {
      const requestedFormat =
        options.format === undefined
          ? undefined
          : FORMAT_IDS.find((candidate) => candidate === options.format);
      if (options.format !== undefined && requestedFormat === undefined) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

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
        const selectedFormat =
          requestedFormat === undefined
            ? item.value.formats[0]
            : item.value.formats.find(({ format }) => format === requestedFormat);
        if (!selectedFormat) {
          command.error("", { exitCode: 1, code: "format-not-found" });
        }

        try {
          const result = await sendToDestination({
            itemId: item.value.id,
            sourcePath: selectedFormat.sourcePath,
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
          const primaryFormat = {
            sourcePath: options.sourcePath,
            format: options.format as FormatId,
            addedAt: options.addedAt,
            provenance: "referenced" as const,
          };
          const result = await store.add({
            item: {
              id: options.id,
              title: options.title,
              sourcePath: primaryFormat.sourcePath,
              format: primaryFormat.format,
              addedAt: primaryFormat.addedAt,
              formats: [primaryFormat],
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
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.import({
            sourcePath: options.sourcePath,
            title: options.title,
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

  const format = storageCommand(library.command("format"), writeError)
    .helpOption(false)
    .addHelpCommand(false)
    .description("Manage an item's document formats");

  storageCommand(format.command("import").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--source-path <path>", "source document path")
    .action(
      async (
        options: { db?: string; id: string; sourcePath: string },
        command: Command,
      ) => {
        if (options.id.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.attachFormat({
            id: options.id,
            source: { kind: "copy", path: options.sourcePath },
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

  storageCommand(format.command("attach").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--source-path <path>", "source document path")
    .action(
      async (
        options: { db?: string; id: string; sourcePath: string },
        command: Command,
      ) => {
        if (options.id.length === 0) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.attachFormat({
            id: options.id,
            source: { kind: "reference", path: options.sourcePath },
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

  storageCommand(format.command("remove").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .requiredOption("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .action(
      async (
        options: { db?: string; id: string; format: string },
        command: Command,
      ) => {
        const formatId = FORMAT_IDS.find((candidate) => candidate === options.format);
        if (options.id.length === 0 || !formatId) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.removeFormat({ id: options.id, format: formatId });
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
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
    .option("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .option("--json", "emit JSON instead of a readable confirmation")
    .action(
      async (
        options: { db?: string; id: string; format?: string; json?: boolean },
        command: Command,
      ) => {
        const requestedFormat =
          options.format === undefined
            ? undefined
            : FORMAT_IDS.find((candidate) => candidate === options.format);
        if (
          options.id.length === 0 ||
          (options.format !== undefined && requestedFormat === undefined)
        ) {
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
          const selectedFormat =
            requestedFormat === undefined
              ? item.formats[0]
              : item.formats.find(({ format }) => format === requestedFormat);
          if (!selectedFormat) {
            command.error("", { exitCode: 1, code: "format-not-found" });
          }

          try {
            if (!(await stat(selectedFormat.sourcePath)).isFile()) {
              command.error("", { exitCode: 1, code: "missing-file" });
            }
          } catch (error) {
            if (error instanceof CommanderError) {
              throw error;
            }
            command.error("", { exitCode: 1, code: "missing-file" });
          }

          const declaredFormat = FORMAT_CATALOG.find(
            (format) => format.id === selectedFormat.format,
          );
          if (
            !declaredFormat?.extensions.includes(
              extname(selectedFormat.sourcePath).toLowerCase(),
            )
          ) {
            command.error("", { exitCode: 1, code: "format-mismatch" });
          }

          try {
            await launch(defaultAppCommand(selectedFormat.sourcePath));
          } catch {
            command.error("", { exitCode: 1, code: "open-failed" });
          }

          write(
            options.json
              ? JSON.stringify({
                  ok: true,
                  value: {
                    id: item.id,
                    format: selectedFormat.format,
                    path: selectedFormat.sourcePath,
                  },
                })
              : `Opened ${selectedFormat.sourcePath}`,
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

      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.remove({ id: options.id });
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }

        write(JSON.stringify({ ok: true, value: result.value }));
      } finally {
        store.close();
      }
    });

  program
    .command("plan")
    .description("Create a conversion plan for an available execution target")
    .requiredOption("--input <path>", "source document path")
    .requiredOption("--to <format>", `target format: ${FORMAT_IDS.join(", ")}`)
    .option("--json", "emit JSON instead of a readable summary")
    .action((options: { input: string; to: string; json?: boolean }) => {
      try {
        const outputFormat = FORMAT_IDS.find((format) => format === options.to);
        if (!outputFormat) {
          program.error(`Unsupported output format '${options.to}'.`, { exitCode: 2 });
          return;
        }
        const job = planConversion({
          input: options.input,
          outputFormat,
          targets: [localTarget],
        });
        if (options.json) {
          write(JSON.stringify(job, null, 2));
          return;
        }
        write(`Planned ${job.id}`);
        write(`  ${job.inputFormat.toUpperCase()} → ${job.outputFormat.toUpperCase()}`);
        write(`  target: ${job.assignedTarget.name} (${job.assignedTarget.id})`);
        write("  status: planned (run takio convert to execute locally)");
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
    const conversionBackend = await discoverEbookConvert();
    await createProgram(
      console.log,
      (message) => process.stdout.write(message),
      undefined,
      undefined,
      process.platform,
      conversionBackend,
    ).parseAsync(argv);
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
