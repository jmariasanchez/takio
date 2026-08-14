#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  CONVERSION_PROFILE_IDS,
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  detectFormat,
  destinationBookFileName,
  destinationFormatPreferences,
  planConversion,
  type BookFormat,
  type Destination,
  type ConversionProfileId,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import {
  exportLibraryItemsRequestSchema,
  importLibraryItemsRequestSchema,
  keepDuplicatePairRequestSchema,
  libraryMetadataPatchSchema,
  listDuplicateCandidatesRequestSchema,
  listLibraryTrashRequestSchema,
  mergeDuplicatePairRequestSchema,
  purgeLibraryItemRequestSchema,
  queryLibraryItemsRequestSchema,
  removeSavedLibraryViewRequestSchema,
  replaceLibraryFormatRequestSchema,
  reopenDuplicatePairRequestSchema,
  restoreLibraryItemRequestSchema,
  saveSavedLibraryViewRequestSchema,
  trashLibraryItemRequestSchema,
  type ExportLibraryItemsRequest,
  type ImportLibraryItemsRequest,
  type KeepDuplicatePairRequest,
  type LibraryExportEntryOutcome,
  type LibraryMetadataPatch,
  type ListDuplicateCandidatesRequest,
  type ListLibraryTrashRequest,
  type MergeDuplicatePairRequest,
  type PurgeLibraryItemRequest,
  type QueryLibraryItemsRequest,
  type RemoveSavedLibraryViewRequest,
  type ReplaceLibraryFormatRequest,
  type ReopenDuplicatePairRequest,
  type RestoreLibraryItemRequest,
  type SaveSavedLibraryViewRequest,
  type TrashLibraryItemRequest,
} from "@takio/library-contract";
import {
  BunSqliteLibraryStore,
  LIBRARY_BACKUP_VERSION,
  LIBRARY_SCHEMA_VERSION,
  createLibraryBackup,
  restoreLibraryBackup,
  verifyLibraryIntegrity,
} from "@takio/library-store-bun";
import {
  ConversionError,
  LOCAL_CONVERSION_CAPABILITIES,
  convertLocal,
  discoverEbookConvert,
  type EbookConvertDiscovery,
} from "./convert.js";
import {
  MaintenanceError,
  POLISH_OPERATIONS,
  TEXT_EXTRACTABLE_FORMATS,
  discoverEbookPolish,
  extractEbookText,
  findLiteralText,
  polishEbook,
  type EbookPolishDiscovery,
  type PolishOperation,
} from "./calibre-maintenance.js";
import { CATALOG_FORMATS, CatalogError, writeCatalog, type CatalogFormat } from "./catalog.js";
import {
  DestinationTransferError,
  authorizeDestination,
  destinationDeliveryRelativePath,
  ejectDestination,
  inventoryDestination,
  listDestinations,
  recordDestinationDelivery,
  removeDestinationDelivery,
  sendToDestination,
} from "./destinations.js";
import { reconcileJobAttachment } from "./job-attachment.js";
import {
  KERNEL_NAME,
  VERIFIED_KERNEL_VERSION,
  resolveKernelReport,
  type KernelReport,
} from "./kernel.js";
import { JOB_STATUSES, JobStore, type ConversionJob, type JobStatus } from "./job-store.js";
import { sendToKindleSsh, type KindleSshRunner } from "./kindle-ssh.js";
import {
  CalibreImportError,
  enrichImportedLibraryOutcomes,
  importCalibreLibrary,
} from "./library-import.js";
import {
  EMBEDDABLE_METADATA_FORMATS,
  MetadataError,
  discoverEbookMeta,
  discoverFetchEbookMetadata,
  extractEbookMetadata,
  fetchOnlineMetadata,
  materializeEbookMetadata,
  type EbookMetaDiscovery,
} from "./metadata.js";
import {
  candidateFromPatch,
  parseFilenameMetadataCandidates,
  parseMetadataCandidateJson,
  type MetadataCandidate,
} from "./metadata-automation.js";
import {
  PORTABLE_LIBRARY_VERSION,
  exportPortableLibrary,
  rebuildPortableLibrary,
} from "./portable-library.js";
import { ContentServerError, startContentServer } from "./remote-server.js";

type LibraryPaths = {
  readonly databasePath: string;
  readonly itemsDirectory: string;
};

type Launcher = (argv: readonly string[]) => void | Promise<void>;
type Ejector = (destinationPath: string) => Promise<number>;

const MAX_LIBRARY_JSON_REQUEST_BYTES = 16 * 1024;
const MAX_BATCH_ITEMS = 256;
const JSON_INPUT_HINT = "JSON, '-' for stdin, or '@path' for a file";
const CLI_VERSION = "0.1.0";
const MACHINE_CONTRACT_VERSION = 2;

type JsonRequestSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function readBoundedJsonInput(
  source: AsyncIterable<string | Uint8Array>,
  command: Command,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_LIBRARY_JSON_REQUEST_BYTES) {
      command.error("", { exitCode: 1, code: "invalid-arguments" });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function resolveJsonInput(value: string, command: Command): Promise<string> {
  if (value !== "-" && !value.startsWith("@")) return value;
  if (value === "@") {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }

  try {
    return await readBoundedJsonInput(
      value === "-" ? process.stdin : createReadStream(resolve(value.slice(1))),
      command,
    );
  } catch (error) {
    if (error instanceof CommanderError) throw error;
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }
}

async function parseLibraryJsonRequest<T>(
  value: string,
  schema: JsonRequestSchema<T>,
  command: Command,
): Promise<T> {
  const input = await resolveJsonInput(value, command);
  if (Buffer.byteLength(input, "utf8") > MAX_LIBRARY_JSON_REQUEST_BYTES) {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(input);
  } catch {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    command.error("", { exitCode: 1, code: "invalid-arguments" });
  }
  return parsed.data;
}

function openWithDefaultApp(argv: readonly string[]): void {
  Bun.spawn({ cmd: [...argv], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

function humanCell(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
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

function selectedLibraryName(command: Command, databasePath?: string): string | undefined {
  const option = command.optsWithGlobals().library;
  return typeof option === "string"
    ? option
    : databasePath === undefined
      ? process.env.TAKIO_LIBRARY
      : undefined;
}

function libraryPaths(databasePath?: string, libraryName?: string): LibraryPaths {
  if (databasePath === "") {
    throw new TypeError("A database path is required.");
  }
  if (
    libraryName === "" ||
    (libraryName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(libraryName)) ||
    (databasePath !== undefined && libraryName !== undefined)
  ) {
    throw new TypeError("A library name must be safe and exclusive with a database path.");
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

  const resolvedRoot = resolve(root, ...(libraryName ? ["libraries", libraryName] : []));
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
    paths = libraryPaths(databasePath, selectedLibraryName(command, databasePath));
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

function jobsDatabasePath(databasePath?: string, libraryName?: string): string {
  if (databasePath === "") {
    throw new TypeError("A database path is required.");
  }
  return databasePath
    ? resolve(databasePath)
    : join(dirname(libraryPaths(undefined, libraryName).databasePath), "jobs.sqlite");
}

async function openJobStore(databasePath: string | undefined, command: Command): Promise<JobStore> {
  let path: string;
  try {
    path = jobsDatabasePath(databasePath, selectedLibraryName(command));
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
    .helpOption("-h, --help", "display help for command")
    .configureOutput({ writeErr: () => {} })
    .exitOverride((error) => {
      const code = error.code.startsWith("commander.") ? "invalid-arguments" : error.code;
      if (!error.code.startsWith("commander.help") && error.code !== "commander.version") {
        write(JSON.stringify({ ok: false, error: { code } }));
      }
      throw error;
    });
}

async function selectLibraryItems(
  store: BunSqliteLibraryStore,
  ids: readonly string[],
  limit: number,
  command: Command,
): Promise<{
  readonly entries: readonly { readonly itemId: string; readonly item?: LibraryItem }[];
  readonly available: number;
}> {
  if (ids.length) {
    const entries: { itemId: string; item?: LibraryItem }[] = [];
    for (const id of ids) {
      const result = await store.get({ id });
      if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
      entries.push({ itemId: id, ...(result.value ? { item: result.value } : {}) });
    }
    return { entries, available: entries.length };
  }
  const result = await store.list({});
  if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
  return {
    entries: result.value.slice(0, limit).map((item) => ({ itemId: item.id, item })),
    available: result.value.length,
  };
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
  metadataBackend: EbookMetaDiscovery = {
    ok: false,
    code: "backend-unavailable",
  },
  polishBackend: EbookPolishDiscovery = {
    ok: false,
    code: "backend-unavailable",
  },
  kindleSshRunner?: KindleSshRunner,
): Command {
  const program = storageCommand(new Command(), writeError);
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
    .description("Manage, convert, and deliver a local ebook library")
    .option("--library <name>", "named library under the Takio data directory")
    .version(CLI_VERSION);

  const currentKernelReport = async (): Promise<{
    readonly kernel: KernelReport;
    readonly onlineMetadataBackend: EbookMetaDiscovery;
  }> => {
    const onlineMetadataBackend = await discoverFetchEbookMetadata();
    const kernel = await resolveKernelReport({
      discoveries: {
        conversion: conversionBackend,
        metadata: metadataBackend,
        onlineMetadata: onlineMetadataBackend,
        polish: polishBackend,
      },
      platform,
    });
    return { kernel, onlineMetadataBackend };
  };

  program
    .command("doctor")
    .description("Report Calibre conversion-kernel health and how to repair it")
    .option("--human", "emit a readable report instead of JSON")
    .action(async (options: { human?: boolean }) => {
      const { kernel } = await currentKernelReport();
      if (!options.human) {
        write(JSON.stringify({
          ok: true,
          value: {
            status: kernel.status,
            cli: { name: "takio", version: CLI_VERSION },
            platform,
            kernel,
          },
        }));
        return;
      }

      write(`takio ${CLI_VERSION} on ${platform}`);
      write(
        `${KERNEL_NAME} kernel: ${kernel.status}` +
          ` (version ${kernel.version ?? "unknown"}, verified baseline ${VERIFIED_KERNEL_VERSION})`,
      );
      for (const executable of kernel.executables) {
        write(
          `  ${executable.available ? "ok     " : "missing"} ${executable.binary}` +
            `  ${executable.available ? `${executable.path} [${executable.source}]` : executable.purpose}`,
        );
      }
      if (kernel.remediation) {
        write(`remediation: ${kernel.remediation.code} — ${kernel.remediation.summary}`);
        for (const action of kernel.remediation.actions) {
          write(`  ${action.kind}: ${action.command}`);
        }
        write(`  docs: ${kernel.remediation.docs}`);
      }
    });

  program
    .command("capabilities")
    .description("Describe the machine contract and currently available backends")
    .action(async () => {
      const { kernel, onlineMetadataBackend } = await currentKernelReport();
      write(JSON.stringify({
        ok: true,
        value: {
          cli: { name: "takio", version: CLI_VERSION },
          kernel,
          protocol: {
            version: MACHINE_CONTRACT_VERSION,
            output: "one-json-object",
            structuredInput: ["inline", "stdin", "file"],
            maxRequestBytes: MAX_LIBRARY_JSON_REQUEST_BYTES,
          },
          library: {
            schemaVersion: LIBRARY_SCHEMA_VERSION,
            backupVersion: LIBRARY_BACKUP_VERSION,
            portableVersion: PORTABLE_LIBRARY_VERSION,
            catalogFormats: CATALOG_FORMATS,
          },
          backends: {
            conversion: conversionBackend.ok
              ? { name: "ebook-convert", available: true }
              : { name: "ebook-convert", available: false, code: conversionBackend.code },
            metadata: metadataBackend.ok
              ? { name: "ebook-meta", available: true }
              : { name: "ebook-meta", available: false, code: metadataBackend.code },
            onlineMetadata: onlineMetadataBackend.ok
              ? { name: "fetch-ebook-metadata", available: true }
              : {
                  name: "fetch-ebook-metadata",
                  available: false,
                  code: onlineMetadataBackend.code,
                },
            polish: polishBackend.ok
              ? { name: "ebook-polish", available: true }
              : { name: "ebook-polish", available: false, code: polishBackend.code },
          },
          formats: FORMAT_CATALOG,
          conversions: {
            available: conversionBackend.ok,
            pairs: LOCAL_CONVERSION_CAPABILITIES,
            profiles: CONVERSION_PROFILE_IDS,
          },
          help: {
            root: "takio --help",
            leaf: "takio <command> --help",
          },
          remote: {
            available: true,
            mode: "foreground-read-only",
            authentication: "per-run-bearer-token",
            remoteTransport: "tls-required",
          },
          transports: {
            usbMassStorage: { available: true, mode: "mounted-filesystem" },
            rootedKindleSsh: {
              available: true,
              gated: true,
              optInRequired: true,
              command: "takio destination rooted-kindle-send",
              binaries: ["ssh", "scp"],
              passwordHandling: false,
              hostKeyCheckingDefault: "strict",
            },
            mtp: { available: false, gated: true, code: "unsupported-transport" },
            sendToKindle: { available: false, gated: true, code: "unsupported-transport" },
          },
        },
      }));
    });

  storageCommand(program.command("serve").helpOption(false), writeError)
    .description("Serve authenticated read-only library access in the foreground")
    .option("--db <path>", "database path")
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", "8787")
    .option("--allow-remote", "allow a non-loopback host when TLS is configured")
    .option("--tls-cert <path>", "PEM certificate for HTTPS")
    .option("--tls-key <path>", "PEM private key for HTTPS")
    .action(async (
      options: {
        db?: string;
        host: string;
        port: string;
        allowRemote?: boolean;
        tlsCert?: string;
        tlsKey?: string;
      },
      command: Command,
    ) => {
      const port = Number(options.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      const { store } = await openLibraryStore(options.db, command);
      let running: Awaited<ReturnType<typeof startContentServer>> | undefined;
      let stop: (() => void) | undefined;
      try {
        try {
          running = await startContentServer({
            store,
            hostname: options.host,
            port,
            allowRemote: options.allowRemote,
            certPath: options.tlsCert,
            keyPath: options.tlsKey,
          });
        } catch (error) {
          command.error("", {
            exitCode: 1,
            code: error instanceof ContentServerError ? error.code : "server-unavailable",
          });
        }
        const stopped = new Promise<void>((resolveStopped) => {
          stop = resolveStopped;
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        write(JSON.stringify({
          ok: true,
          value: {
            server: {
              url: running.url,
              token: running.token,
              mode: "foreground-read-only",
            },
          },
        }));
        await stopped;
      } finally {
        if (stop) {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
        await running?.server.stop(true);
        store.close();
      }
    });

  program
    .command("formats")
    .description("List the built-in format catalogue")
    .option("--json", "emit JSON instead of a table")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        write(JSON.stringify({ ok: true, value: { formats: FORMAT_CATALOG } }));
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
    .option("--json", "emit JSON instead of a table")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        write(JSON.stringify({ ok: true, value: { devices: [localTarget] } }));
        return;
      }
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
    .description("Convert a local document with Calibre ebook-convert")
    .requiredOption("--input <path>", "source document path")
    .requiredOption("--to <format>", `target format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--output <path>", "output artifact path")
    .option(
      "--profile <profile>",
      `Calibre output profile: ${CONVERSION_PROFILE_IDS.join(", ")}`,
      "default",
    )
    .option("--timeout-seconds <seconds>", "conversion timeout", "300");
  program.addCommand(convert);

  convert.action(
    async (
      options: {
        input: string;
        to: string;
        output: string;
        profile: string;
        timeoutSeconds: string;
      },
      command: Command,
    ) => {
      const timeoutSeconds = Number(options.timeoutSeconds);
      if (
        !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds <= 0 ||
        timeoutSeconds > Math.floor(2_147_483_647 / 1000) ||
        !CONVERSION_PROFILE_IDS.includes(options.profile as ConversionProfileId)
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
          profileId: options.profile as ConversionProfileId,
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

  const polish = storageCommand(new Command("polish"), writeError)
    .description("Polish a new EPUB, KEPUB, or AZW3 artifact with Calibre ebook-polish")
    .requiredOption("--input <path>", "source ebook path")
    .requiredOption("--output <path>", "new polished artifact path")
    .requiredOption(
      "--operation <operation>",
      `operation (repeatable): ${POLISH_OPERATIONS.join(", ")}`,
      (operation: string, operations: string[]) => [...operations, operation],
      [],
    )
    .option("--timeout-seconds <seconds>", "polish timeout", "300");
  program.addCommand(polish);

  polish.action(async (
    options: {
      input: string;
      output: string;
      operation: string[];
      timeoutSeconds: string;
    },
    command: Command,
  ) => {
    const timeoutSeconds = Number(options.timeoutSeconds);
    if (
      !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 ||
      timeoutSeconds > Math.floor(2_147_483_647 / 1000) ||
      options.operation.some((operation) => !POLISH_OPERATIONS.includes(operation as PolishOperation))
    ) {
      command.error("", { exitCode: 1, code: "invalid-arguments" });
    }
    if (!polishBackend.ok) {
      command.error("", { exitCode: 1, code: polishBackend.code });
    }
    try {
      const job = await polishEbook({
        backendPath: polishBackend.path,
        input: options.input,
        output: options.output,
        operations: options.operation as PolishOperation[],
        timeoutMs: timeoutSeconds * 1000,
      });
      write(JSON.stringify({ ok: true, value: { job } }));
    } catch (error) {
      if (error instanceof MaintenanceError) {
        command.error("", { exitCode: 1, code: error.code });
      }
      throw error;
    }
  });

  const metadata = storageCommand(new Command("metadata"), writeError)
    .description("Inspect embedded ebook metadata through Calibre ebook-meta");
  program.addCommand(metadata);

  storageCommand(metadata.command("extract").helpOption(false), writeError)
    .description("Extract normalized metadata without changing the source or library")
    .requiredOption("--source-path <path>", "source ebook path")
    .option("--timeout-seconds <seconds>", "metadata extraction timeout", "15")
    .action(
      async (
        options: { sourcePath: string; timeoutSeconds: string },
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

        if (!metadataBackend.ok) {
          command.error("", { exitCode: 1, code: metadataBackend.code });
        }
        try {
          const extracted = await extractEbookMetadata({
            backendPath: metadataBackend.path,
            sourcePath: options.sourcePath,
            timeoutMs: timeoutSeconds * 1000,
          });
          write(
            JSON.stringify({
              ok: true,
              value: {
                sourcePath: extracted.sourcePath,
                metadata: extracted.metadata,
                cover: extracted.cover
                  ? {
                      mediaType: extracted.cover.mediaType,
                      extension: extracted.cover.extension,
                      bytes: extracted.cover.bytes.byteLength,
                    }
                  : null,
              },
            }),
          );
        } catch (error) {
          if (error instanceof MetadataError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          throw error;
        }
      },
    );

  storageCommand(metadata.command("fetch").helpOption(false), writeError)
    .description("Fetch a reviewable metadata candidate without changing the library")
    .option("--title <title>", "book title")
    .option(
      "--author <author>",
      "book author (repeatable)",
      (author: string, authors: string[]) => [...authors, author],
      [],
    )
    .option(
      "--identifier <kind:value>",
      "book identifier (repeatable)",
      (identifier: string, identifiers: string[]) => [...identifiers, identifier],
      [],
    )
    .option("--cover-output <path>", "publish a fetched cover to a new file")
    .option("--timeout-seconds <seconds>", "online metadata timeout", "30")
    .action(
      async (
        options: {
          title?: string;
          author: string[];
          identifier: string[];
          coverOutput?: string;
          timeoutSeconds: string;
        },
        command: Command,
      ) => {
        const timeoutSeconds = Number(options.timeoutSeconds);
        const identifiers: Record<string, string> = {};
        for (const input of options.identifier) {
          const separator = input.indexOf(":");
          const kind = input.slice(0, separator).trim().toLowerCase();
          const value = input.slice(separator + 1).trim();
          if (
            separator <= 0 ||
            !kind ||
            !value ||
            identifiers[kind] !== undefined
          ) {
            command.error("", { exitCode: 1, code: "invalid-arguments" });
          }
          identifiers[kind] = value;
        }
        if (
          !Number.isSafeInteger(timeoutSeconds) ||
          timeoutSeconds <= 0 ||
          timeoutSeconds > Math.floor(2_147_483_647 / 1000) ||
          (options.title !== undefined && options.title.trim() === "") ||
          options.author.some((author) => author.trim() === "") ||
          (!options.title?.trim() && options.author.length === 0 && !identifiers.isbn)
        ) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }

        const backend = await discoverFetchEbookMetadata();
        if (!backend.ok) {
          command.error("", { exitCode: 1, code: backend.code });
        }
        try {
          const fetched = await fetchOnlineMetadata({
            backendPath: backend.path,
            title: options.title,
            authors: options.author,
            identifiers,
            coverOutputPath: options.coverOutput,
            timeoutMs: timeoutSeconds * 1000,
          });
          write(JSON.stringify({ ok: true, value: fetched }));
        } catch (error) {
          if (error instanceof MetadataError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          throw error;
        }
      },
    );

  const metadataAutomation = storageCommand(metadata.command("candidates").helpOption(false), writeError)
    .description("Review bounded metadata candidates without changing the library");

  storageCommand(metadataAutomation.command("filename").helpOption(false), writeError)
    .description("Parse filename metadata candidates using configurable named-group regex patterns")
    .requiredOption("--source-path <path>", "ebook source path or filename")
    .option("--id <id>", "library item ID for provenance")
    .option(
      "--pattern <regex>",
      "extra ECMAScript regex with named groups title, author, series, seriesIndex",
      (pattern: string, patterns: string[]) => [...patterns, pattern],
      [],
    )
    .action((options: { sourcePath: string; id?: string; pattern: string[] }, command: Command) => {
      try {
        const candidates = parseFilenameMetadataCandidates({
          sourcePath: options.sourcePath,
          itemId: options.id,
          patterns: options.pattern,
          generatedAt: new Date(0).toISOString(),
        });
        write(JSON.stringify({ ok: true, value: { candidates } }));
      } catch {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
    });

  storageCommand(metadataAutomation.command("item").helpOption(false), writeError)
    .description("Fetch filename, embedded, and online candidates for one existing library item")
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--include-online", "also run fetch-ebook-metadata")
    .option("--timeout-seconds <seconds>", "per-backend timeout", "30")
    .action(async (options: { db?: string; id: string; includeOnline?: boolean; timeoutSeconds: string }, command: Command) => {
      const timeoutSeconds = Number(options.timeoutSeconds);
      if (options.id.trim() === "" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      const { store } = await openLibraryStore(options.db, command);
      try {
        const found = await store.get({ id: options.id });
        if (!found.ok) command.error("", { exitCode: 1, code: found.error.code });
        if (!found.value) command.error("", { exitCode: 1, code: "item-not-found" });
        const item = found.value!;
        const generatedAt = new Date(0).toISOString();
        const candidates: MetadataCandidate[] = [
          ...parseFilenameMetadataCandidates({ sourcePath: item.sourcePath, itemId: item.id, generatedAt }),
        ];
        if (metadataBackend.ok) {
          try {
            const extracted = await extractEbookMetadata({
              backendPath: metadataBackend.path,
              sourcePath: item.sourcePath,
              timeoutMs: timeoutSeconds * 1000,
            });
            const candidate = candidateFromPatch({
              id: "embedded:1",
              source: "embedded",
              confidence: "high",
              patch: extracted.metadata,
              provenance: { generatedAt, itemId: item.id, sourcePath: extracted.sourcePath, backend: "ebook-meta" },
            });
            if (candidate) candidates.push(candidate);
          } catch {
            // Candidate collection is non-destructive: unavailable embedded metadata is reported by omission.
          }
        }
        if (options.includeOnline) {
          const backend = await discoverFetchEbookMetadata();
          if (backend.ok) {
            try {
              const fetched = await fetchOnlineMetadata({
                backendPath: backend.path,
                title: item.title,
                authors: item.authors?.map(({ name }) => name) ?? (item.author ? [item.author] : []),
                identifiers: item.identifiers,
                timeoutMs: timeoutSeconds * 1000,
              });
              const candidate = candidateFromPatch({
                id: "online:1",
                source: "online",
                confidence: "medium",
                patch: fetched.metadata,
                provenance: { generatedAt, itemId: item.id, backend: "fetch-ebook-metadata" },
              });
              if (candidate) candidates.push(candidate);
            } catch {
              // Online candidate failures do not mutate or fail the review workflow.
            }
          }
        }
        write(JSON.stringify({ ok: true, value: { itemId: item.id, candidates: candidates.slice(0, 8) } }));
      } finally {
        store.close();
      }
    });

  storageCommand(metadataAutomation.command("apply").helpOption(false), writeError)
    .description("Explicitly apply a selected candidate or patch with provenance")
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--candidate-json <json>", `metadata candidate as ${JSON_INPUT_HINT}`)
    .option("--patch-json <json>", `manual metadata patch as ${JSON_INPUT_HINT}`)
    .requiredOption("--provenance <text>", "human-readable provenance/review note")
    .action(async (options: { db?: string; id: string; candidateJson?: string; patchJson?: string; provenance: string }, command: Command) => {
      if (options.id.trim() === "" || options.provenance.trim() === "" || (options.candidateJson === undefined) === (options.patchJson === undefined)) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      let patch: LibraryMetadataPatch;
      let candidate: MetadataCandidate | null = null;
      try {
        if (options.candidateJson !== undefined) {
          candidate = parseMetadataCandidateJson(options.candidateJson);
          if (!candidate) command.error("", { exitCode: 1, code: "invalid-arguments" });
          patch = candidate!.patch;
        } else {
          patch = await parseLibraryJsonRequest<LibraryMetadataPatch>(options.patchJson!, libraryMetadataPatchSchema, command);
        }
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        command.error("", { exitCode: 1, code: "invalid-arguments" });
        throw error;
      }
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.update({ id: options.id, patch });
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        if (!result.value) command.error("", { exitCode: 1, code: "item-not-found" });
        write(JSON.stringify({ ok: true, value: { item: result.value, applied: { candidateId: candidate?.id ?? null, source: candidate?.source ?? "manual", provenance: options.provenance } } }));
      } finally {
        store.close();
      }
    });

  const jobs = storageCommand(new Command("jobs"), writeError)
    .description("Manage durable foreground conversion jobs");
  program.addCommand(jobs);

  const runNextJob = async (
    store: JobStore,
    databasePath: string | undefined,
    command: Command,
  ): Promise<ConversionJob | null> => {
    const reconcileClaimedAttachment = async (job: ConversionJob): Promise<ConversionJob> => {
      if (databasePath !== undefined) {
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
      return reconcileClaimedAttachment(pendingAttachment.value);
    }

    if (!conversionBackend.ok) {
      command.error("", { exitCode: 1, code: conversionBackend.code });
    }
    const claimed = store.claimNext();
    if (!claimed.ok) command.error("", { exitCode: 1, code: claimed.error.code });
    if (!claimed.value) return null;

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
    return result.value;
  };

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

  storageCommand(jobs.command("retry").helpOption(false), writeError)
    .description("Re-enqueue a failed or canceled job without erasing its history")
    .option("--db <path>", "jobs database path")
    .requiredOption("--id <id>", "job ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.id === "") command.error("", { exitCode: 1, code: "invalid-arguments" });
      const store = await openJobStore(options.db, command);
      try {
        const result = store.retry(options.id);
        if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
        write(JSON.stringify({ ok: true, value: { job: result.value, retriedFrom: options.id } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("retry-attachment").helpOption(false), writeError)
    .description("Retry a failed library attachment without rerunning conversion")
    .option("--db <path>", "jobs database path")
    .requiredOption("--id <id>", "job ID")
    .action(async (options: { db?: string; id: string }, command: Command) => {
      if (options.db !== undefined || options.id === "") {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      const store = await openJobStore(undefined, command);
      try {
        const result = store.retryAttachment(options.id);
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
        const job = await runNextJob(store, options.db, command);
        write(JSON.stringify({ ok: true, value: { job } }));
      } finally {
        store.close();
      }
    });

  storageCommand(jobs.command("drain").helpOption(false), writeError)
    .description("Run queued conversions in the foreground until empty or bounded")
    .option("--db <path>", "jobs database path")
    .option("--max-jobs <count>", "maximum jobs to process", "256")
    .action(async (
      options: { db?: string; maxJobs: string },
      command: Command,
    ) => {
      const maxJobs = Number(options.maxJobs);
      if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 256) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const store = await openJobStore(options.db, command);
      try {
        const jobs: ConversionJob[] = [];
        for (let index = 0; index < maxJobs; index += 1) {
          const job = await runNextJob(store, options.db, command);
          if (!job) break;
          jobs.push(job);
          if (job.errorCode === "conversion-cancelled") break;
        }
        const listed = store.list();
        if (!listed.ok) command.error("", { exitCode: 1, code: listed.error.code });
        const remaining = listed.value.filter(
          (job) => job.status === "queued" || job.attachment?.status === "pending",
        ).length;
        write(JSON.stringify({
          ok: true,
          value: {
            jobs,
            counts: {
              processed: jobs.length,
              completed: jobs.filter(({ status }) => status === "completed").length,
              failed: jobs.filter(({ status }) => status === "failed").length,
              canceled: jobs.filter(({ status }) => status === "canceled").length,
              remaining,
            },
          },
        }));
      } finally {
        store.close();
      }
    });

  const destination = storageCommand(new Command("destination"), writeError)
    .description("Manage mounted document destinations");
  program.addCommand(destination);

  storageCommand(destination.command("rooted-kindle-send").helpOption(false), writeError)
    .description("Opt-in upload to a rooted Kindle over SSH/SCP for KOReader paths")
    .requiredOption("--source <path>", "local file to upload")
    .requiredOption("--id <id>", "library or caller item ID")
    .requiredOption("--host <host>", "Kindle SSH host; no passwords are handled")
    .requiredOption("--user <user>", "Kindle SSH user")
    .requiredOption("--remote-root <path>", "absolute /mnt/us/.../documents or KOReader directory")
    .option("--port <port>", "SSH port", "22")
    .option("--identity-file <path>", "absolute private key path")
    .option("--file-name <name>", "published remote file name")
    .option("--timeout-ms <milliseconds>", "bounded per-command timeout", "30000")
    .option("--accept-new-host-key", "allow OpenSSH accept-new instead of strict known-host matching")
    .action(async (
      options: {
        source: string;
        id: string;
        host: string;
        user: string;
        remoteRoot: string;
        port: string;
        identityFile?: string;
        fileName?: string;
        timeoutMs: string;
        acceptNewHostKey?: boolean;
      },
      command: Command,
    ) => {
      const port = Number(options.port);
      const timeoutMs = Number(options.timeoutMs);
      if (options.id.trim() === "" || !Number.isSafeInteger(port) || !Number.isSafeInteger(timeoutMs)) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      try {
        const result = await sendToKindleSsh({
          itemId: options.id,
          sourcePath: options.source,
          fileName: options.fileName,
          destination: {
            host: options.host,
            user: options.user,
            port,
            remoteRoot: options.remoteRoot,
            identityFile: options.identityFile,
            strictHostKeyChecking: !options.acceptNewHostKey,
            timeoutMs,
          },
          runner: kindleSshRunner,
        });
        write(JSON.stringify({ ok: true, value: result }));
      } catch (error) {
        if (error instanceof DestinationTransferError) {
          command.error("", { exitCode: 1, code: error.code });
        }
        throw error;
      }
    });

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

  storageCommand(destination.command("inventory").helpOption(false), writeError)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes")
    .action(async (options: { dest: string; volumesRoot: string }, command: Command) => {
      const mountedDestination = await authorizeDestination(options.dest, options.volumesRoot);
      if (!mountedDestination) command.error("", { exitCode: 1, code: "unknown-destination" });
      try {
        const entries = await inventoryDestination(mountedDestination);
        write(JSON.stringify({ ok: true, value: { destinationId: mountedDestination.id, entries } }));
      } catch (error) {
        if (error instanceof DestinationTransferError) command.error("", { exitCode: 1, code: error.code });
        throw error;
      }
    });

  storageCommand(destination.command("reconcile").helpOption(false), writeError)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes")
    .action(async (options: { dest: string; volumesRoot: string }, command: Command) => {
      const mountedDestination = await authorizeDestination(options.dest, options.volumesRoot);
      if (!mountedDestination) command.error("", { exitCode: 1, code: "unknown-destination" });
      try {
        const entries = await inventoryDestination(mountedDestination);
        write(JSON.stringify({ ok: true, value: { destinationId: mountedDestination.id, entries } }));
      } catch (error) {
        if (error instanceof DestinationTransferError) command.error("", { exitCode: 1, code: error.code });
        throw error;
      }
    });

  storageCommand(destination.command("remove").helpOption(false), writeError)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .requiredOption("--id <id>", "Takio delivery item ID")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes")
    .action(async (options: { dest: string; id: string; volumesRoot: string }, command: Command) => {
      const mountedDestination = await authorizeDestination(options.dest, options.volumesRoot);
      if (!mountedDestination || options.id.trim() === "") {
        command.error("", { exitCode: 1, code: mountedDestination ? "invalid-arguments" : "unknown-destination" });
      }
      try {
        const removed = await removeDestinationDelivery(mountedDestination, options.id);
        write(JSON.stringify({ ok: true, value: { destinationId: mountedDestination.id, removed } }));
      } catch (error) {
        if (error instanceof DestinationTransferError) command.error("", { exitCode: 1, code: error.code });
        throw error;
      }
    });

  const deliverFormat = async (
    item: LibraryItem,
    selectedFormat: BookFormat,
    mountedDestination: Destination,
    options: { subdir?: string; overwrite?: boolean },
  ) => {
    const deliveryExtension =
      selectedFormat.format === "kepub" && mountedDestination.kind === "kobo"
        ? "kepub.epub"
        : selectedFormat.format;
    const deliveryName = destinationBookFileName(
      item.title,
      item.authors?.[0]?.name ?? item.author,
      deliveryExtension,
    );
    let metadataWorkspace: string | undefined;
    try {
      let sourcePath = selectedFormat.sourcePath;
      let metadata: "embedded" | "unsupported" | "backend-unavailable" =
        EMBEDDABLE_METADATA_FORMATS.includes(selectedFormat.format)
          ? "backend-unavailable"
          : "unsupported";
      if (metadataBackend.ok && metadata !== "unsupported") {
        metadataWorkspace = await mkdtemp(join(tmpdir(), "takio-send-metadata-"));
        await chmod(metadataWorkspace, 0o700);
        sourcePath = join(metadataWorkspace, deliveryName);
        try {
          await copyFile(selectedFormat.sourcePath, sourcePath);
        } catch {
          throw new DestinationTransferError("source-unavailable");
        }
        await materializeEbookMetadata({
          backendPath: metadataBackend.path,
          artifactPath: sourcePath,
          format: selectedFormat.format,
          item,
          timeoutMs: 15_000,
        });
        metadata = "embedded";
      }
      const result = await sendToDestination({
        itemId: item.id,
        sourcePath,
        fileName: deliveryName,
        destination: mountedDestination,
        subdir: options.subdir,
        overwrite: options.overwrite,
      });
      const relativePath = destinationDeliveryRelativePath(mountedDestination, result.path);
      await recordDestinationDelivery(mountedDestination, {
        itemId: result.itemId,
        relativePath,
        bytes: result.bytes,
        sha256: result.sha256,
        format: selectedFormat.format,
      });
      return { ...result, format: selectedFormat.format, metadata };
    } finally {
      if (metadataWorkspace) {
        await rm(metadataWorkspace, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  const send = storageCommand(new Command("send"), writeError)
    .description("Send a library item to a mounted destination")
    .option("--db <path>", "database path")
    .requiredOption("--id <id>", "library item ID")
    .option("--format <format>", `document format: ${FORMAT_IDS.join(", ")}`)
    .option("--convert", "create and attach the requested format when missing")
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
        convert?: boolean;
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
        const preferredFormats = destinationFormatPreferences(
          destination.kind,
          destination.features,
        );
        let targetFormat = requestedFormat;
        let selectedFormat = requestedFormat === undefined
          ? preferredFormats.length === 0
            ? item.value.formats[0]
            : preferredFormats
                .map((format) => item.value!.formats.find((candidate) => candidate.format === format))
                .find((candidate) => candidate !== undefined)
          : item.value.formats.find(({ format }) => format === requestedFormat);
        if (!selectedFormat && options.convert && targetFormat === undefined) {
          targetFormat = preferredFormats.find((format) =>
            item.value!.formats.some(({ format: source }) =>
              LOCAL_CONVERSION_CAPABILITIES.some(
                ({ from, to }) => from === source && to === format,
              ),
            ),
          );
        }
        let converted = false;
        if (!selectedFormat && options.convert && targetFormat) {
          const sourceFormat = item.value.formats.find(({ format }) =>
            LOCAL_CONVERSION_CAPABILITIES.some(
              ({ from, to }) => from === format && to === targetFormat,
            ),
          );
          if (!sourceFormat) {
            command.error("", { exitCode: 1, code: "unsupported-conversion" });
          }
          if (!conversionBackend.ok) {
            command.error("", { exitCode: 1, code: conversionBackend.code });
          }

          let workspace: string | undefined;
          try {
            workspace = await mkdtemp(join(tmpdir(), "takio-send-"));
            await chmod(workspace, 0o700);
            const conversion = await convertLocal({
              backendPath: conversionBackend.path,
              input: sourceFormat.sourcePath,
              output: join(workspace, `converted.${targetFormat}`),
              outputFormat: targetFormat,
              profileId:
                destination.kind === "kobo"
                  ? "kobo"
                  : destination.kind === "kindle"
                    ? "kindle"
                    : "default",
              timeoutMs: 300_000,
            });
            const attached = await store.attachFormat({
              id: item.value.id,
              source: {
                kind: "copy",
                path: conversion.artifact.path,
                expectedArtifact: {
                  bytes: conversion.artifact.bytes,
                  sha256: conversion.artifact.sha256,
                },
              },
            });
            if (!attached.ok) {
              command.error("", { exitCode: 1, code: attached.error.code });
            }
            if (!attached.value) {
              command.error("", { exitCode: 1, code: "unknown-item" });
            }
            selectedFormat = attached.value.formats.find(
              ({ format }) => format === targetFormat,
            );
            if (!selectedFormat) {
              command.error("", { exitCode: 1, code: "format-not-found" });
            }
            converted = true;
          } catch (error) {
            if (error instanceof CommanderError) throw error;
            if (error instanceof ConversionError) {
              command.error("", { exitCode: 1, code: error.code });
            }
            command.error("", { exitCode: 1, code: "conversion-failed" });
          } finally {
            if (workspace) {
              await rm(workspace, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
        if (!selectedFormat) {
          command.error("", { exitCode: 1, code: "format-not-found" });
        }

        try {
          const result = await deliverFormat(item.value, selectedFormat, destination, options);
          write(
            JSON.stringify({
              ok: true,
              value: { ...result, converted },
            }),
          );
        } catch (error) {
          if (error instanceof DestinationTransferError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          if (error instanceof MetadataError) {
            command.error("", { exitCode: 1, code: error.code });
          }
          throw error;
        }
      } finally {
        store.close();
      }
    },
  );

  const sendMany = storageCommand(new Command("send-many"), writeError)
    .description("Send attached formats for a bounded set of library items")
    .option("--db <path>", "database path")
    .requiredOption(
      "--id <id>",
      "library item ID (repeatable)",
      (id: string, ids: string[]) => [...ids, id],
      [],
    )
    .requiredOption("--format <format>", `attached document format: ${FORMAT_IDS.join(", ")}`)
    .requiredOption("--dest <volume-path>", "mounted destination path")
    .option("--subdir <dir>", "destination subdirectory")
    .option("--overwrite", "replace existing destination files")
    .option("--volumes-root <path>", "mounted-volume root", "/Volumes");
  program.addCommand(sendMany);

  sendMany.action(async (
    options: {
      db?: string;
      id: string[];
      format: string;
      dest: string;
      subdir?: string;
      overwrite?: boolean;
      volumesRoot: string;
    },
    command: Command,
  ) => {
    const format = FORMAT_IDS.find((candidate) => candidate === options.format);
    if (
      !format || options.id.length < 1 || options.id.length > MAX_BATCH_ITEMS ||
      options.id.some((id) => id.trim() === "") || new Set(options.id).size !== options.id.length
    ) {
      command.error("", { exitCode: 1, code: "invalid-arguments" });
    }
    const destination = await authorizeDestination(options.dest, options.volumesRoot);
    if (!destination) command.error("", { exitCode: 1, code: "unknown-destination" });

    const { store } = await openLibraryStore(options.db, command);
    try {
      const outcomes: Array<
        | ({ status: "sent" } & Awaited<ReturnType<typeof deliverFormat>>)
        | { status: "failed"; itemId: string; code: string }
      > = [];
      for (const id of options.id) {
        const found = await store.get({ id });
        if (!found.ok) {
          outcomes.push({ status: "failed", itemId: id, code: found.error.code });
          continue;
        }
        if (!found.value) {
          outcomes.push({ status: "failed", itemId: id, code: "unknown-item" });
          continue;
        }
        const selectedFormat = found.value.formats.find((candidate) => candidate.format === format);
        if (!selectedFormat) {
          outcomes.push({ status: "failed", itemId: id, code: "format-not-found" });
          continue;
        }
        try {
          outcomes.push({
            status: "sent",
            ...(await deliverFormat(found.value, selectedFormat, destination, options)),
          });
        } catch (error) {
          outcomes.push({
            status: "failed",
            itemId: id,
            code: error instanceof DestinationTransferError || error instanceof MetadataError
              ? error.code
              : "copy-failed",
          });
        }
      }
      write(JSON.stringify({
        ok: true,
        value: {
          outcomes,
          counts: {
            total: outcomes.length,
            sent: outcomes.filter(({ status }) => status === "sent").length,
            failed: outcomes.filter(({ status }) => status === "failed").length,
          },
        },
      }));
    } finally {
      store.close();
    }
  });

  const library = storageCommand(new Command("library"), writeError)
    .description("Manage a durable local library");
  program.addCommand(library);

  storageCommand(library.command("verify").helpOption(false), writeError)
    .description("Verify the database and managed library files without changing them")
    .option("--db <path>", "database path")
    .action((options: { db?: string }, command: Command) => {
      let paths: LibraryPaths;
      try {
        paths = libraryPaths(options.db, selectedLibraryName(command, options.db));
      } catch {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const result = verifyLibraryIntegrity(paths.databasePath);
      if (!result.ok) {
        command.error("", { exitCode: 1, code: result.error.code });
      }
      write(JSON.stringify({ ok: true, value: { report: result.value } }));
    });

  storageCommand(library.command("backup").helpOption(false), writeError)
    .description("Create a verified backup of the database and Takio-owned files")
    .option("--db <path>", "database path")
    .requiredOption("--dest <directory>", "new backup directory")
    .action((options: { db?: string; dest: string }, command: Command) => {
      let paths: LibraryPaths;
      try {
        paths = libraryPaths(options.db, selectedLibraryName(command, options.db));
      } catch {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const result = createLibraryBackup(paths.databasePath, options.dest);
      if (!result.ok) {
        command.error("", { exitCode: 1, code: result.error.code });
      }
      write(JSON.stringify({ ok: true, value: { backup: result.value } }));
    });

  storageCommand(library.command("restore-backup").helpOption(false), writeError)
    .description("Restore a verified backup into a new, absent library directory")
    .option("--db <path>", "new database path")
    .requiredOption("--source <directory>", "Takio backup directory")
    .action((options: { db?: string; source: string }, command: Command) => {
      let paths: LibraryPaths;
      try {
        paths = libraryPaths(options.db, selectedLibraryName(command, options.db));
      } catch {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const result = restoreLibraryBackup(options.source, paths.databasePath);
      if (!result.ok) {
        command.error("", { exitCode: 1, code: result.error.code });
      }
      write(JSON.stringify({ ok: true, value: { restore: result.value } }));
    });

  storageCommand(library.command("portable-export").helpOption(false), writeError)
    .description("Export active books, formats, covers, and OPF metadata to a portable directory")
    .option("--db <path>", "database path")
    .requiredOption("--dest <directory>", "new portable export directory")
    .action(async (options: { db?: string; dest: string }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await exportPortableLibrary(store, options.dest);
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }
        write(JSON.stringify({ ok: true, value: { export: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("rebuild").helpOption(false), writeError)
    .description("Rebuild a new library from a verified Takio portable OPF export")
    .requiredOption("--db <path>", "database path inside a new, absent directory")
    .requiredOption("--source <directory>", "Takio portable export directory")
    .action(async (options: { db: string; source: string }, command: Command) => {
      let paths: LibraryPaths;
      try {
        paths = libraryPaths(options.db, selectedLibraryName(command, options.db));
      } catch {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const result = await rebuildPortableLibrary(options.source, paths.databasePath);
      if (!result.ok) {
        command.error("", { exitCode: 1, code: result.error.code });
      }
      write(JSON.stringify({ ok: true, value: { rebuild: result.value } }));
    });

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
    .option("--human", "emit a readable table instead of JSON")
    .action(async (options: { db?: string; human?: boolean }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.list({});
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }

        if (options.human) {
          write("ID\tTITLE\tAUTHORS\tFORMATS");
          for (const item of result.value) {
            const authors = item.authors?.map(({ name }) => name).join(", ") ?? item.author ?? "";
            write(`${humanCell(item.id)}\t${humanCell(item.title)}\t${humanCell(authors)}\t${item.formats.map(({ format }) => format).join(",")}`);
          }
        } else {
          write(JSON.stringify({ ok: true, value: { items: result.value } }));
        }
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("catalog").helpOption(false), writeError)
    .description("Write a shareable catalog without exposing local source paths")
    .option("--db <path>", "database path")
    .requiredOption("--format <format>", `catalog format: ${CATALOG_FORMATS.join(", ")}`)
    .requiredOption("--output <path>", "new .json, .csv, or .html output path")
    .action(async (
      options: { db?: string; format: string; output: string },
      command: Command,
    ) => {
      const format = CATALOG_FORMATS.find((candidate) => candidate === options.format);
      if (!format) command.error("", { exitCode: 1, code: "invalid-arguments" });
      const { store } = await openLibraryStore(options.db, command);
      try {
        const listed = await store.list({});
        if (!listed.ok) command.error("", { exitCode: 1, code: listed.error.code });
        try {
          const catalog = await writeCatalog({
            items: listed.value,
            format: format as CatalogFormat,
            outputPath: options.output,
          });
          write(JSON.stringify({ ok: true, value: { catalog } }));
        } catch (error) {
          command.error("", {
            exitCode: 1,
            code: error instanceof CatalogError ? error.code : "write-failed",
          });
        }
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
          const [outcome] = await enrichImportedLibraryOutcomes(
            store,
            [{ status: "imported", sourcePath: options.sourcePath, item: result.value }],
            { titleOverride: options.title },
          );
          const item = outcome?.status === "imported" ? outcome.item : result.value;
          write(JSON.stringify({ ok: true, value: { item } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(library.command("import-many").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption(
      "--source-path <path>",
      "file or directory to import recursively (repeatable)",
      (sourcePath: string, sourcePaths: string[] | undefined) => [
        ...(sourcePaths ?? []),
        sourcePath,
      ],
    )
    .action(
      async (
        options: { db?: string; sourcePath: string[] },
        command: Command,
      ) => {
        const parsedRequest = importLibraryItemsRequestSchema.safeParse({
          roots: options.sourcePath,
        });
        if (!parsedRequest.success) {
          command.error("", { exitCode: 1, code: "invalid-arguments" });
        }
        const request: ImportLibraryItemsRequest = parsedRequest.data;
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.importMany(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          const outcomes = await enrichImportedLibraryOutcomes(store, result.value.outcomes);
          write(JSON.stringify({ ok: true, value: { ...result.value, outcomes } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(library.command("import-calibre").helpOption(false), writeError)
    .description("Import a Calibre library directory containing metadata.db without modifying it")
    .option("--db <path>", "database path")
    .requiredOption("--library-root <path>", "Calibre library directory containing metadata.db")
    .action(async (options: { db?: string; libraryRoot: string }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const report = await importCalibreLibrary(store, options.libraryRoot);
        write(JSON.stringify({ ok: true, value: report }));
      } catch (error) {
        if (error instanceof CalibreImportError) {
          command.error("", { exitCode: 1, code: error.code });
        }
        command.error("", { exitCode: 1, code: "storage-unavailable" });
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("import-watch").helpOption(false), writeError)
    .description("Rescan import roots in the foreground until stopped or cycle-bounded")
    .option("--db <path>", "database path")
    .requiredOption(
      "--source-path <path>",
      "file or directory to import recursively (repeatable)",
      (sourcePath: string, sourcePaths: string[] | undefined) => [
        ...(sourcePaths ?? []),
        sourcePath,
      ],
    )
    .option("--interval-seconds <seconds>", "seconds between scans", "30")
    .option("--max-cycles <count>", "stop after this many scans")
    .action(async (
      options: {
        db?: string;
        sourcePath: string[];
        intervalSeconds: string;
        maxCycles?: string;
      },
      command: Command,
    ) => {
      const parsedRequest = importLibraryItemsRequestSchema.safeParse({ roots: options.sourcePath });
      const intervalSeconds = Number(options.intervalSeconds);
      const maxCycles = options.maxCycles === undefined ? undefined : Number(options.maxCycles);
      if (
        !parsedRequest.success || !Number.isSafeInteger(intervalSeconds) ||
        intervalSeconds < 1 || intervalSeconds > 86_400 ||
        (maxCycles !== undefined && (
          !Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > 10_000
        ))
      ) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }

      const { store } = await openLibraryStore(options.db, command);
      let stopped = false;
      let wake = () => {};
      const stop = () => {
        stopped = true;
        wake();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const counts = { total: 0, imported: 0, skipped: 0, duplicates: 0, failed: 0 };
        let cycles = 0;
        while (!stopped && (maxCycles === undefined || cycles < maxCycles)) {
          const result = await store.importMany(parsedRequest.data);
          if (!result.ok) command.error("", { exitCode: 1, code: result.error.code });
          await enrichImportedLibraryOutcomes(store, result.value.outcomes);
          cycles += 1;
          for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
            counts[key] += result.value.counts[key];
          }
          if (stopped || (maxCycles !== undefined && cycles >= maxCycles)) break;
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, intervalSeconds * 1000);
            wake = () => {
              clearTimeout(timer);
              resolveWait();
            };
          });
          wake = () => {};
        }
        write(JSON.stringify({ ok: true, value: { cycles, stopped, counts } }));
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        store.close();
      }
    });

  storageCommand(library.command("export-many").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `export request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request: ExportLibraryItemsRequest = await parseLibraryJsonRequest(
          options.requestJson,
          exportLibraryItemsRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const items = new Map<string, LibraryItem>();
          for (const id of request.ids) {
            const item = await store.get({ id });
            if (!item.ok) {
              command.error("", { exitCode: 1, code: item.error.code });
            }
            if (item.value) items.set(id, item.value);
          }
          const result = await store.exportMany(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          const outcomes: LibraryExportEntryOutcome[] = [];
          for (const outcome of result.value.outcomes) {
            if (outcome.status !== "exported") {
              outcomes.push(outcome);
              continue;
            }
            if (!EMBEDDABLE_METADATA_FORMATS.includes(outcome.format)) {
              outcomes.push({ ...outcome, metadata: "unsupported" });
              continue;
            }
            if (!metadataBackend.ok) {
              outcomes.push({ ...outcome, metadata: "backend-unavailable" });
              continue;
            }

            const item = items.get(outcome.itemId);
            try {
              if (!item) throw new MetadataError("metadata-write-failed");
              const artifact = await materializeEbookMetadata({
                backendPath: metadataBackend.path,
                artifactPath: outcome.destinationPath,
                format: outcome.format,
                item,
                timeoutMs: 15_000,
              });
              outcomes.push({
                ...outcome,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                metadata: "embedded",
              });
            } catch {
              await rm(outcome.destinationPath, { force: true }).catch(() => {});
              outcomes.push({
                status: "failed",
                itemId: outcome.itemId,
                format: outcome.format,
                provenance: outcome.provenance,
                destinationPath: outcome.destinationPath,
                code: "metadata-write-failed",
              });
            }
          }
          write(JSON.stringify({
            ok: true,
            value: {
              outcomes,
              counts: {
                total: outcomes.length,
                exported: outcomes.filter(({ status }) => status === "exported").length,
                skipped: outcomes.filter(({ status }) => status === "skipped").length,
                failed: outcomes.filter(({ status }) => status === "failed").length,
              },
            },
          }));
        } finally {
          store.close();
        }
      },
    );

  const format = storageCommand(library.command("format"), writeError)
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

  storageCommand(format.command("replace").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption(
      "--request-json <json>",
      `atomic format replacement request as ${JSON_INPUT_HINT}`,
    )
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<ReplaceLibraryFormatRequest>(
          options.requestJson,
          replaceLibraryFormatRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.replaceFormat(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
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
    .option("--patch-json <json>", `structured metadata patch as ${JSON_INPUT_HINT}`)
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
          patchJson?: string;
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

        let patch: LibraryMetadataPatch;
        if (options.patchJson !== undefined) {
          const mixesLegacyMetadata = ["title", "author", "description", "tag"].some(
            (name) => command.getOptionValueSource(name) === "cli",
          );
          if (mixesLegacyMetadata) {
            command.error("", { exitCode: 1, code: "invalid-arguments" });
          }
          patch = await parseLibraryJsonRequest<LibraryMetadataPatch>(
            options.patchJson,
            libraryMetadataPatchSchema,
            command,
          );
        } else {
          patch = {
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
          };
        }

        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.update({
            id: options.id,
            patch,
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

  storageCommand(library.command("update-many").helpOption(false), writeError)
    .description("Apply one metadata patch to a bounded set of library items")
    .option("--db <path>", "database path")
    .requiredOption(
      "--id <id>",
      "library item ID (repeatable)",
      (id: string, ids: string[]) => [...ids, id],
      [],
    )
    .requiredOption("--patch-json <json>", `structured metadata patch as ${JSON_INPUT_HINT}`)
    .action(async (
      options: { db?: string; id: string[]; patchJson: string },
      command: Command,
    ) => {
      if (
        options.id.length < 1 || options.id.length > MAX_BATCH_ITEMS ||
        options.id.some((id) => id.trim() === "") || new Set(options.id).size !== options.id.length
      ) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      const patch = await parseLibraryJsonRequest<LibraryMetadataPatch>(
        options.patchJson,
        libraryMetadataPatchSchema,
        command,
      );
      const { store } = await openLibraryStore(options.db, command);
      try {
        const outcomes: Array<
          | { status: "updated"; itemId: string; item: LibraryItem }
          | { status: "missing"; itemId: string }
          | { status: "failed"; itemId: string; code: string }
        > = [];
        for (const id of options.id) {
          const result = await store.update({ id, patch });
          if (!result.ok) {
            outcomes.push({ status: "failed", itemId: id, code: result.error.code });
          } else if (!result.value) {
            outcomes.push({ status: "missing", itemId: id });
          } else {
            outcomes.push({ status: "updated", itemId: id, item: result.value });
          }
        }
        write(JSON.stringify({
          ok: true,
          value: {
            outcomes,
            counts: {
              total: outcomes.length,
              updated: outcomes.filter(({ status }) => status === "updated").length,
              missing: outcomes.filter(({ status }) => status === "missing").length,
              failed: outcomes.filter(({ status }) => status === "failed").length,
            },
          },
        }));
      } finally {
        store.close();
      }
    });

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

  storageCommand(library.command("content-search").helpOption(false), writeError)
    .description("Search literal text through bounded temporary Calibre extraction")
    .option("--db <path>", "database path")
    .requiredOption("--query <query>", "case-insensitive literal text")
    .option(
      "--id <id>",
      "library item ID (repeatable; all selected when omitted)",
      (id: string, ids: string[]) => [...ids, id],
      [],
    )
    .option("--limit <count>", "maximum selected items", "256")
    .option("--timeout-seconds <seconds>", "text extraction timeout per item", "60")
    .action(async (
      options: {
        db?: string;
        query: string;
        id: string[];
        limit: string;
        timeoutSeconds: string;
      },
      command: Command,
    ) => {
      const limit = Number(options.limit);
      const timeoutSeconds = Number(options.timeoutSeconds);
      if (
        options.query.trim() === "" || options.id.length > MAX_BATCH_ITEMS ||
        options.id.some((id) => id.trim() === "") || new Set(options.id).size !== options.id.length ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_ITEMS ||
        options.id.length > limit || !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds < 1 || timeoutSeconds > Math.floor(2_147_483_647 / 1000)
      ) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      if (!conversionBackend.ok) {
        command.error("", { exitCode: 1, code: conversionBackend.code });
      }

      const { store } = await openLibraryStore(options.db, command);
      try {
        const selected = await selectLibraryItems(store, options.id, limit, command);
        const outcomes: Array<Record<string, unknown> & { status: string }> = [];
        let canceled = false;
        for (const entry of selected.entries) {
          if (!entry.item) {
            outcomes.push({ status: "missing", itemId: entry.itemId });
            continue;
          }
          const format = entry.item.formats.find((candidate) =>
            TEXT_EXTRACTABLE_FORMATS.includes(candidate.format)
          );
          if (!format) {
            outcomes.push({
              status: "skipped",
              itemId: entry.itemId,
              code: "unsupported-format",
            });
            continue;
          }
          try {
            const extracted = await extractEbookText({
              backendPath: conversionBackend.path,
              sourcePath: format.sourcePath,
              timeoutMs: timeoutSeconds * 1000,
            });
            const found = findLiteralText(extracted.text, options.query);
            outcomes.push(found.matches
              ? {
                  status: "matched",
                  itemId: entry.itemId,
                  title: entry.item.title,
                  format: format.format,
                  ...found,
                }
              : { status: "no-match", itemId: entry.itemId, format: format.format });
          } catch (error) {
            const code = error instanceof MaintenanceError ? error.code : "extraction-failed";
            outcomes.push({ status: "failed", itemId: entry.itemId, format: format.format, code });
            if (code === "maintenance-cancelled") {
              canceled = true;
              break;
            }
          }
        }
        write(JSON.stringify({
          ok: true,
          value: {
            query: options.query,
            available: selected.available,
            selected: selected.entries.length,
            canceled,
            outcomes,
            counts: {
              total: outcomes.length,
              matched: outcomes.filter(({ status }) => status === "matched").length,
              noMatch: outcomes.filter(({ status }) => status === "no-match").length,
              missing: outcomes.filter(({ status }) => status === "missing").length,
              skipped: outcomes.filter(({ status }) => status === "skipped").length,
              failed: outcomes.filter(({ status }) => status === "failed").length,
            },
          },
        }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("validate").helpOption(false), writeError)
    .description("Check Calibre metadata parsing and bounded text extraction, not EPUB conformance")
    .option("--db <path>", "database path")
    .option(
      "--id <id>",
      "library item ID (repeatable; all selected when omitted)",
      (id: string, ids: string[]) => [...ids, id],
      [],
    )
    .option("--limit <count>", "maximum selected items", "256")
    .option("--timeout-seconds <seconds>", "backend timeout per check", "60")
    .action(async (
      options: { db?: string; id: string[]; limit: string; timeoutSeconds: string },
      command: Command,
    ) => {
      const limit = Number(options.limit);
      const timeoutSeconds = Number(options.timeoutSeconds);
      if (
        options.id.length > MAX_BATCH_ITEMS || options.id.some((id) => id.trim() === "") ||
        new Set(options.id).size !== options.id.length || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > MAX_BATCH_ITEMS || options.id.length > limit ||
        !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 ||
        timeoutSeconds > Math.floor(2_147_483_647 / 1000)
      ) {
        command.error("", { exitCode: 1, code: "invalid-arguments" });
      }
      if (!metadataBackend.ok) command.error("", { exitCode: 1, code: metadataBackend.code });

      const { store } = await openLibraryStore(options.db, command);
      try {
        const selected = await selectLibraryItems(store, options.id, limit, command);
        const outcomes: Array<Record<string, unknown> & { status: string }> = [];
        for (const entry of selected.entries) {
          if (!entry.item) {
            outcomes.push({ status: "missing", itemId: entry.itemId });
            continue;
          }
          for (const format of entry.item.formats) {
            try {
              await extractEbookMetadata({
                backendPath: metadataBackend.path,
                sourcePath: format.sourcePath,
                timeoutMs: timeoutSeconds * 1000,
              });
              let content: "checked" | "not-applicable" = "not-applicable";
              if (TEXT_EXTRACTABLE_FORMATS.includes(format.format)) {
                if (!conversionBackend.ok) throw new MaintenanceError(conversionBackend.code);
                await extractEbookText({
                  backendPath: conversionBackend.path,
                  sourcePath: format.sourcePath,
                  timeoutMs: timeoutSeconds * 1000,
                });
                content = "checked";
              }
              outcomes.push({
                status: "valid",
                itemId: entry.itemId,
                format: format.format,
                content,
              });
            } catch (error) {
              outcomes.push({
                status: "failed",
                itemId: entry.itemId,
                format: format.format,
                code: error instanceof MetadataError || error instanceof MaintenanceError
                  ? error.code
                  : "validation-failed",
              });
            }
          }
        }
        write(JSON.stringify({
          ok: true,
          value: {
            available: selected.available,
            selected: selected.entries.length,
            outcomes,
            counts: {
              total: outcomes.length,
              valid: outcomes.filter(({ status }) => status === "valid").length,
              missing: outcomes.filter(({ status }) => status === "missing").length,
              failed: outcomes.filter(({ status }) => status === "failed").length,
            },
          },
        }));
      } finally {
        store.close();
      }
    });

  storageCommand(library.command("query").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `structured catalogue query as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<QueryLibraryItemsRequest>(
          options.requestJson,
          queryLibraryItemsRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.query(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  const duplicates = storageCommand(library.command("duplicates"), writeError)
    .description("Review duplicate library items");

  storageCommand(duplicates.command("list").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption(
      "--request-json <json>",
      `duplicate candidate page request as ${JSON_INPUT_HINT}`,
    )
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<ListDuplicateCandidatesRequest>(
          options.requestJson,
          listDuplicateCandidatesRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.listDuplicateCandidates(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(duplicates.command("keep").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `duplicate pair keep request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<KeepDuplicatePairRequest>(
          options.requestJson,
          keepDuplicatePairRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.keepDuplicatePair(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(duplicates.command("reopen").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `duplicate pair reopen request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<ReopenDuplicatePairRequest>(
          options.requestJson,
          reopenDuplicatePairRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.reopenDuplicatePair(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(duplicates.command("merge").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `duplicate pair merge request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<MergeDuplicatePairRequest>(
          options.requestJson,
          mergeDuplicatePairRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.mergeDuplicatePair(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  const savedViews = storageCommand(library.command("saved-views"), writeError)
    .description("Manage saved catalogue views");

  storageCommand(savedViews.command("list").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .action(async (options: { db?: string }, command: Command) => {
      const { store } = await openLibraryStore(options.db, command);
      try {
        const result = await store.listSavedViews({});
        if (!result.ok) {
          command.error("", { exitCode: 1, code: result.error.code });
        }
        write(JSON.stringify({ ok: true, value: { views: result.value } }));
      } finally {
        store.close();
      }
    });

  storageCommand(savedViews.command("save").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `saved-view definition as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<SaveSavedLibraryViewRequest>(
          options.requestJson,
          saveSavedLibraryViewRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.saveSavedView(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: { view: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(savedViews.command("remove").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `saved-view removal request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<RemoveSavedLibraryViewRequest>(
          options.requestJson,
          removeSavedLibraryViewRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.removeSavedView(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: { view: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  const cover = storageCommand(library.command("cover"), writeError)
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

  const trash = storageCommand(library.command("trash"), writeError)
    .description("Manage trashed library items");

  storageCommand(trash.command("list").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `trash page request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<ListLibraryTrashRequest>(
          options.requestJson,
          listLibraryTrashRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.listTrash(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(trash.command("move").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `trash request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<TrashLibraryItemRequest>(
          options.requestJson,
          trashLibraryItemRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.trash(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: { item: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(trash.command("restore").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `restore request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<RestoreLibraryItemRequest>(
          options.requestJson,
          restoreLibraryItemRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.restore(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: { item: result.value } }));
        } finally {
          store.close();
        }
      },
    );

  storageCommand(trash.command("purge").helpOption(false), writeError)
    .option("--db <path>", "database path")
    .requiredOption("--request-json <json>", `purge request as ${JSON_INPUT_HINT}`)
    .action(
      async (
        options: { db?: string; requestJson: string },
        command: Command,
      ) => {
        const request = await parseLibraryJsonRequest<PurgeLibraryItemRequest>(
          options.requestJson,
          purgeLibraryItemRequestSchema,
          command,
        );
        const { store } = await openLibraryStore(options.db, command);
        try {
          const result = await store.purge(request);
          if (!result.ok) {
            command.error("", { exitCode: 1, code: result.error.code });
          }
          write(JSON.stringify({ ok: true, value: result.value }));
        } finally {
          store.close();
        }
      },
    );

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
          program.error("", { exitCode: 2, code: "invalid-arguments" });
          return;
        }
        const job = planConversion({
          input: options.input,
          outputFormat,
          targets: [localTarget],
        });
        if (options.json) {
          write(JSON.stringify({ ok: true, value: { job } }));
          return;
        }
        write(`Planned ${job.id}`);
        write(`  ${job.inputFormat.toUpperCase()} → ${job.outputFormat.toUpperCase()}`);
        write(`  target: ${job.assignedTarget.name} (${job.assignedTarget.id})`);
        write("  status: planned (run takio convert to execute locally)");
      } catch (error) {
        if (error instanceof PlanningError) {
          program.error("", { exitCode: 2, code: "planning-failed" });
        }
        throw error;
      }
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  try {
    const [conversionBackend, metadataBackend, polishBackend] = await Promise.all([
      discoverEbookConvert(),
      discoverEbookMeta(),
      discoverEbookPolish(),
    ]);
    await createProgram(
      console.log,
      (message) => process.stdout.write(message),
      undefined,
      undefined,
      process.platform,
      conversionBackend,
      metadataBackend,
      polishBackend,
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
