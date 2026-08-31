import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import * as electron from "electron";
import { join } from "node:path";
import {
  applyMetadataCandidateRequestSchema,
  libraryHealthBackupRequestSchema,
  libraryHealthDiagnosticsRequestSchema,
  listMetadataCandidatesRequestSchema,
} from "@takio/library-contract";

const { app } = electron;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_ARGUMENT_BYTES = 16 * 1024;
const MAX_CONCURRENT_INVOCATIONS = 4;
const MAX_SERVICE_PENDING = 16;
const LIBRARY_SERVICE_COMMANDS = new Set([
  "library_update",
  "library_attach_format",
  "library_remove_format",
  "library_replace_format",
  "library_cover_set",
  "library_cover_remove",
  "library_trash",
  "library_restore",
  "library_purge",
]);

type CommandArguments = Record<string, unknown> | undefined;
type EngineResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string } };

type ServiceRecord = EngineResult & { readonly id?: unknown };
type LibraryServiceProcess = {
  readonly stdin: { write: (chunk: string, callback: (error?: Error | null) => void) => boolean };
  readonly stdout: { on: (event: "data", listener: (chunk: Buffer) => void) => unknown };
  readonly stderr: { on: (event: "data", listener: (chunk: Buffer) => void) => unknown };
  kill: () => boolean;
  once: (event: "error" | "close", listener: (...args: unknown[]) => void) => unknown;
};

let activeInvocations = 0;
let nextServiceId = 1;

function failure(code: string): EngineResult {
  return { ok: false, error: { code } };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function objectJson(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return null;
  }
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= MAX_JSON_ARGUMENT_BYTES ? json : null;
}

async function existingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function jsonCommand(prefix: readonly string[], value: unknown, flag = "--request-json") {
  const json = objectJson(value);
  return json ? [...prefix, flag, json] : null;
}

export async function buildEngineArguments(
  command: string,
  args: CommandArguments,
): Promise<string[] | null> {
  const input = args ?? {};
  const id = input.id;
  const format = input.format;
  const request = input.request;

  switch (command) {
    case "app_report_library_usable":
      return [];
    case "library_health_location":
      return ["library", "path"];
    case "library_health_verify":
      return ["library", "verify"];
    case "library_health_backup": {
      const parsed = libraryHealthBackupRequestSchema.safeParse(input);
      return parsed.success
        ? ["library", "backup", "--dest", parsed.data.destinationPath]
        : null;
    }
    case "library_health_diagnostics": {
      const parsed = libraryHealthDiagnosticsRequestSchema.safeParse(input);
      return parsed.success
        ? ["library", "diagnostics", "--dest", parsed.data.destinationPath]
        : null;
    }
    case "library_list":
      return ["library", "list"];
    case "library_custom_columns_list":
      return ["library", "custom-columns", "list"];
    case "library_get":
      return nonempty(id) ? ["library", "get", "--id", id] : null;
    case "metadata_candidates_list": {
      const parsed = listMetadataCandidatesRequestSchema.safeParse(request);
      if (!parsed.success) return null;
      return [
        "metadata",
        "candidates",
        "item",
        "--id",
        parsed.data.itemId,
        ...(parsed.data.includeOnline ? ["--include-online"] : []),
      ];
    }
    case "metadata_candidates_apply": {
      const parsed = applyMetadataCandidateRequestSchema.safeParse(request);
      if (!parsed.success) return null;
      const selectedPatch = Object.fromEntries(
        parsed.data.fields.map((field) => [
          field,
          parsed.data.candidate.patch[field as keyof typeof parsed.data.candidate.patch],
        ]),
      );
      const candidateJson = objectJson({
        ...parsed.data.candidate,
        patch: selectedPatch,
      });
      return candidateJson
        ? [
            "metadata",
            "candidates",
            "apply",
            "--id",
            parsed.data.itemId,
            "--candidate-json",
            candidateJson,
            ...(parsed.data.cover ? ["--cover"] : []),
            "--provenance",
            parsed.data.provenance,
          ]
        : null;
    }
    case "library_import":
      return nonempty(input.sourcePath) && (await existingFile(input.sourcePath))
        ? ["library", "import", "--source-path", input.sourcePath]
        : null;
    case "library_import_many": {
      const roots = input.sourcePaths;
      const mode = input.mode;
      if (
        !Array.isArray(roots) ||
        roots.length < 1 ||
        roots.length > 256 ||
        !roots.every(nonempty) ||
        (mode !== "copy" && mode !== "move")
      ) {
        return null;
      }
      return [
        "library",
        "import-many",
        ...roots.flatMap((root) => ["--source-path", root]),
        "--mode",
        mode,
      ];
    }
    case "library_export_many":
      return jsonCommand(["library", "export-many"], request);
    case "library_attach_format": {
      if (!nonempty(id) || !nonempty(input.sourcePath) || !(await existingFile(input.sourcePath))) {
        return null;
      }
      const action = input.mode === "copy" ? "import" : input.mode === "reference" ? "attach" : null;
      return action
        ? ["library", "format", action, "--id", id, "--source-path", input.sourcePath]
        : null;
    }
    case "library_remove_format":
      return nonempty(id) && nonempty(format)
        ? ["library", "format", "remove", "--id", id, "--format", format]
        : null;
    case "library_replace_format":
      return jsonCommand(["library", "format", "replace"], request);
    case "library_update": {
      const patch = objectJson(input.patch);
      return nonempty(id) && patch
        ? ["library", "update", "--id", id, "--patch-json", patch]
        : null;
    }
    case "library_search":
      return typeof input.query === "string"
        ? ["library", "search", "--query", input.query]
        : null;
    case "library_query":
      return jsonCommand(["library", "query"], request);
    case "library_duplicates_list":
      return jsonCommand(["library", "duplicates", "list"], request);
    case "library_duplicates_keep":
      return jsonCommand(["library", "duplicates", "keep"], request);
    case "library_duplicates_reopen":
      return jsonCommand(["library", "duplicates", "reopen"], request);
    case "library_duplicates_merge":
      return jsonCommand(["library", "duplicates", "merge"], request);
    case "library_trash_list":
      return jsonCommand(["library", "trash", "list"], request);
    case "library_trash":
      return jsonCommand(["library", "trash", "move"], request);
    case "library_restore":
      return jsonCommand(["library", "trash", "restore"], request);
    case "library_purge":
      return jsonCommand(["library", "trash", "purge"], request);
    case "library_saved_views_list":
      return ["library", "saved-views", "list"];
    case "library_saved_view_save":
      return jsonCommand(["library", "saved-views", "save"], request);
    case "library_saved_view_remove":
      return jsonCommand(["library", "saved-views", "remove"], request);
    case "library_cover_set":
      return nonempty(id) && nonempty(input.sourcePath) && (await existingFile(input.sourcePath))
        ? ["library", "cover", "set", "--id", id, "--source-path", input.sourcePath]
        : null;
    case "library_cover_remove":
      return nonempty(id) ? ["library", "cover", "remove", "--id", id] : null;
    case "library_open":
      return nonempty(id) && nonempty(format)
        ? ["library", "open", "--id", id, "--format", format, "--json"]
        : null;
    case "destination_list":
      return ["destination", "list"];
    case "destination_send": {
      if (
        !nonempty(id) ||
        !nonempty(format) ||
        !nonempty(input.destinationPath) ||
        typeof input.convertIfNeeded !== "boolean"
      ) {
        return null;
      }
      const sendArgs = ["send", "--id", id, "--format", format, "--dest", input.destinationPath];
      return input.convertIfNeeded ? [...sendArgs, "--convert"] : sendArgs;
    }
    case "destination_rooted_kindle_send": {
      const port = input.port;
      const timeoutMs = input.timeoutMs;
      if (
        !nonempty(id) ||
        !nonempty(format) ||
        !nonempty(input.host) ||
        !nonempty(input.user) ||
        !nonempty(input.remoteRoot) ||
        !nonempty(input.identityFile) ||
        typeof port !== "number" ||
        !Number.isSafeInteger(port) ||
        typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs)
      ) {
        return null;
      }
      return [
        "destination",
        "rooted-kindle-send",
        "--id",
        id,
        "--format",
        format,
        "--host",
        input.host,
        "--user",
        input.user,
        "--remote-root",
        input.remoteRoot,
        "--identity-file",
        input.identityFile,
        "--port",
        String(port),
        "--timeout-ms",
        String(timeoutMs),
      ];
    }
    case "destination_eject":
      return nonempty(input.destinationPath)
        ? ["destination", "eject", "--dest", input.destinationPath]
        : null;
    case "destination_inventory":
      return nonempty(input.destinationPath)
        ? ["destination", "inventory", "--dest", input.destinationPath]
        : null;
    case "destination_reconcile":
      return nonempty(input.destinationPath)
        ? ["destination", "reconcile", "--dest", input.destinationPath]
        : null;
    case "destination_remove":
      return nonempty(input.destinationPath) && nonempty(input.itemId)
        ? ["destination", "remove", "--dest", input.destinationPath, "--id", input.itemId]
        : null;
    case "jobs_list":
      return ["jobs", "list"];
    case "jobs_enqueue": {
      if (!nonempty(input.to) || !nonempty(input.output)) {
        return null;
      }
      const source = nonempty(input.input)
        ? ["--input", input.input]
        : nonempty(input.libraryItemId) && nonempty(input.from)
          ? ["--library-item-id", input.libraryItemId, "--from", input.from]
          : null;
      return source
        ? ["jobs", "enqueue", ...source, "--to", input.to, "--output", input.output]
        : null;
    }
    case "jobs_run_next":
      return ["jobs", "run-next"];
    case "jobs_cancel":
      return nonempty(id) ? ["jobs", "cancel", "--id", id] : null;
    case "jobs_retry":
      return nonempty(id) ? ["jobs", "retry", "--id", id] : null;
    default:
      return null;
  }
}

function enginePath(): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  return join(root, "bin", `takio-library-engine${extension}`);
}

export function parseEngineRecord(
  exitCode: number | null,
  stdout: Buffer,
  stderr: Buffer,
): EngineResult {
  if (stdout.length > MAX_OUTPUT_BYTES || stderr.length > MAX_OUTPUT_BYTES || stderr.length > 0) {
    return failure("protocol-error");
  }
  try {
    const record = JSON.parse(stdout.toString("utf8")) as EngineResult;
    const payloadValid = record.ok
      ? Object.hasOwn(record, "value")
      : nonempty(record.error?.code);
    const exitMatches = exitCode === 0 ? record.ok : exitCode !== null && !record.ok;
    return payloadValid && exitMatches ? record : failure("protocol-error");
  } catch {
    return failure("protocol-error");
  }
}

async function runEngine(args: readonly string[]): Promise<EngineResult> {
  if (activeInvocations >= MAX_CONCURRENT_INVOCATIONS) {
    return failure("engine-unavailable");
  }
  activeInvocations += 1;
  try {
    return await new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const child = spawn(enginePath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const finish = (result: EngineResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const append = (current: Buffer, chunk: Buffer) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(failure("protocol-error"));
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", () => finish(failure("engine-unavailable")));
      child.once("close", (code) => finish(parseEngineRecord(code, stdout, stderr)));
    });
  } finally {
    activeInvocations -= 1;
  }
}

export class LibraryServiceClient {
  readonly #spawnEngine: (args: readonly string[]) => LibraryServiceProcess;
  #child: LibraryServiceProcess | null = null;
  #pending = new Map<string, { resolve: (result: EngineResult) => void }>();
  #buffer = "";

  constructor(spawnEngine: (args: readonly string[]) => LibraryServiceProcess = (args) =>
    spawn(enginePath(), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })) {
    this.#spawnEngine = spawnEngine;
  }

  invoke(command: string, args: CommandArguments): Promise<EngineResult> {
    if (!LIBRARY_SERVICE_COMMANDS.has(command)) return Promise.resolve(failure("invalid-arguments"));
    const input = args ?? {};
    const requestJson = objectJson(servicePayload(command, input));
    if (!requestJson || this.#pending.size >= MAX_SERVICE_PENDING) {
      return Promise.resolve(failure(requestJson ? "engine-unavailable" : "invalid-arguments"));
    }
    const id = String(nextServiceId++);
    const line = JSON.stringify({ id, command, args: JSON.parse(requestJson) }) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_JSON_ARGUMENT_BYTES) {
      return Promise.resolve(failure("invalid-arguments"));
    }
    const child = this.#ensureChild();
    if (!child) return Promise.resolve(failure("engine-unavailable"));
    return new Promise((resolve) => {
      this.#pending.set(id, { resolve });
      try {
        child.stdin.write(line, (error) => {
          if (error) this.#failAll("engine-unavailable");
        });
      } catch {
        this.#failAll("engine-unavailable");
      }
    });
  }

  close(): void {
    const child = this.#child;
    this.#child = null;
    this.#failPending("engine-unavailable");
    child?.kill();
  }

  #ensureChild(): LibraryServiceProcess | null {
    if (this.#child) return this.#child;
    let child: LibraryServiceProcess;
    try {
      child = this.#spawnEngine(["library", "service"]);
    } catch {
      return null;
    }
    this.#child = child;
    this.#buffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", () => this.#failAll("protocol-error"));
    child.once("error", () => this.#failAll("engine-unavailable"));
    child.once("close", () => this.#failAll("engine-unavailable"));
    return child;
  }

  #onStdout(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_OUTPUT_BYTES) {
      this.#failAll("protocol-error");
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_BYTES) {
        this.#failAll("protocol-error");
        return;
      }
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let record: ServiceRecord;
    try {
      record = JSON.parse(line) as ServiceRecord;
    } catch {
      this.#failAll("protocol-error");
      return;
    }
    const id = typeof record.id === "string" ? record.id : "";
    const pending = this.#pending.get(id);
    if (record.ok !== true && record.ok !== false) {
      this.#failAll("protocol-error");
      return;
    }
    const keys = Object.keys(record).sort();
    const validKeys = record.ok
      ? keys.length === 3 && keys[0] === "id" && keys[1] === "ok" && keys[2] === "value"
      : keys.length === 3 && keys[0] === "error" && keys[1] === "id" && keys[2] === "ok";
    const errorKeys = record.ok || typeof record.error !== "object" || record.error === null
      ? []
      : Object.keys(record.error).sort();
    const validError = record.ok || (errorKeys.length === 1 && errorKeys[0] === "code");
    const valid = validKeys && validError && (record.ok ? Object.hasOwn(record, "value") : nonempty(record.error?.code));
    if (!pending || !valid) {
      this.#failAll("protocol-error");
      return;
    }
    this.#pending.delete(id);
    pending.resolve(record.ok ? { ok: true, value: record.value } : { ok: false, error: { code: record.error.code } });
  }

  #failAll(code: string): void {
    const child = this.#child;
    this.#child = null;
    child?.kill();
    this.#failPending(code);
  }

  #failPending(code: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.resolve(failure(code));
  }
}

function servicePayload(command: string, input: Record<string, unknown>): unknown {
  if (command === "library_update") return { id: input.id, patch: input.patch };
  if (command === "library_attach_format") {
    const mode = input.mode;
    return {
      id: input.id,
      source: mode === "copy"
        ? { kind: "copy", path: input.sourcePath, ...(input.expectedArtifact ? { expectedArtifact: input.expectedArtifact } : {}) }
        : mode === "reference"
          ? { kind: "reference", path: input.sourcePath }
          : undefined,
    };
  }
  if (command === "library_remove_format") return { id: input.id, format: input.format };
  if (command === "library_cover_set") return { id: input.id, sourcePath: input.sourcePath };
  if (command === "library_cover_remove") return { id: input.id };
  return input.request;
}

export const libraryServiceClient = new LibraryServiceClient();

export async function invokeEngine(command: string, input?: CommandArguments): Promise<EngineResult> {
  if (command === "app_report_library_usable") {
    if (process.env.TAKIO_STARTUP_BENCHMARK === "1") {
      console.error("TAKIO_LIBRARY_USABLE");
    }
    return { ok: true, value: null };
  }
  const args = await buildEngineArguments(command, input);
  if (LIBRARY_SERVICE_COMMANDS.has(command)) {
    return args ? libraryServiceClient.invoke(command, input) : failure("invalid-arguments");
  }
  return args ? runEngine(args) : failure("invalid-arguments");
}
