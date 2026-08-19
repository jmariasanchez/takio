import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import * as electron from "electron";
import { join } from "node:path";

const { app } = electron;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_JSON_ARGUMENT_BYTES = 16 * 1024;
const MAX_CONCURRENT_INVOCATIONS = 4;

type CommandArguments = Record<string, unknown> | undefined;
type EngineResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string } };

let activeInvocations = 0;

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
    case "library_list":
      return ["library", "list"];
    case "library_get":
      return nonempty(id) ? ["library", "get", "--id", id] : null;
    case "library_import":
      return nonempty(input.sourcePath) && (await existingFile(input.sourcePath))
        ? ["library", "import", "--source-path", input.sourcePath]
        : null;
    case "library_import_many": {
      const roots = input.sourcePaths;
      if (!Array.isArray(roots) || roots.length < 1 || roots.length > 256 || !roots.every(nonempty)) {
        return null;
      }
      return ["library", "import-many", ...roots.flatMap((root) => ["--source-path", root])];
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
    case "destination_send":
      return nonempty(id) && nonempty(format) && nonempty(input.destinationPath)
        ? ["send", "--id", id, "--format", format, "--dest", input.destinationPath]
        : null;
    case "destination_eject":
      return nonempty(input.destinationPath)
        ? ["destination", "eject", "--dest", input.destinationPath]
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

export async function invokeEngine(command: string, input?: CommandArguments): Promise<EngineResult> {
  if (command === "app_report_library_usable") {
    if (process.env.TAKIO_STARTUP_BENCHMARK === "1") {
      console.error("TAKIO_LIBRARY_USABLE");
    }
    return { ok: true, value: null };
  }
  const args = await buildEngineArguments(command, input);
  return args ? runEngine(args) : failure("invalid-arguments");
}
