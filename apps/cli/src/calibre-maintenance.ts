import { detectFormat, type FormatId } from "@takio/core";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  link,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 ** 3;
const MACOS_POLISH_BINARY = "/Applications/calibre.app/Contents/MacOS/ebook-polish";

export const TEXT_EXTRACTABLE_FORMATS: readonly FormatId[] = [
  "kepub",
  "epub",
  "pdf",
  "mobi",
  "azw3",
  "docx",
  "html",
  "txt",
];

export const POLISH_OPERATIONS = [
  "embed-fonts",
  "subset-fonts",
  "smarten-punctuation",
  "remove-unused-css",
  "compress-images",
  "add-soft-hyphens",
  "remove-soft-hyphens",
  "upgrade-book",
] as const;

export type PolishOperation = (typeof POLISH_OPERATIONS)[number];

type MaintenanceErrorCode =
  | "invalid-arguments"
  | "backend-unavailable"
  | "source-unavailable"
  | "unsupported-format"
  | "output-file-exists"
  | "extraction-failed"
  | "maintenance-timeout"
  | "maintenance-cancelled"
  | "artifact-invalid"
  | "polish-failed"
  | "copy-failed";

export class MaintenanceError extends Error {
  constructor(readonly code: MaintenanceErrorCode) {
    super(code);
    this.name = "MaintenanceError";
  }
}

export type EbookPolishDiscovery =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "invalid-arguments" | "backend-unavailable" };

type Source = { readonly path: string; readonly format: FormatId };

async function executable(path: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await stat(canonicalPath)).isFile()) return null;
    await access(canonicalPath, constants.X_OK);
    return canonicalPath;
  } catch {
    return null;
  }
}

export async function discoverEbookPolish(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  macosBundleBinary: string = MACOS_POLISH_BINARY,
): Promise<EbookPolishDiscovery> {
  if (Object.hasOwn(env, "TAKIO_EBOOK_POLISH")) {
    const override = env.TAKIO_EBOOK_POLISH;
    if (!override) return { ok: false, code: "invalid-arguments" };
    const path = await executable(override);
    return path ? { ok: true, path } : { ok: false, code: "backend-unavailable" };
  }

  let fromPath: string | null = null;
  try {
    fromPath = Bun.which("ebook-polish", { PATH: env.PATH });
  } catch {
    // An unusable search path is a discovery miss.
  }
  if (fromPath) {
    const path = await executable(fromPath);
    if (path) return { ok: true, path };
  }
  if (platform === "darwin") {
    const path = await executable(macosBundleBinary);
    if (path) return { ok: true, path };
  }
  return { ok: false, code: "backend-unavailable" };
}

function childEnvironment(workspace: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.TMPDIR = workspace;
  environment.TMP = workspace;
  environment.TEMP = workspace;
  return environment;
}

async function sourceFile(sourcePath: string): Promise<Source> {
  if (!sourcePath) throw new MaintenanceError("invalid-arguments");
  try {
    const path = await realpath(resolve(sourcePath));
    const metadata = await stat(path);
    const format = detectFormat(path);
    if (!metadata.isFile() || metadata.size === 0 || !format) {
      throw new MaintenanceError(format ? "source-unavailable" : "unsupported-format");
    }
    await access(path, constants.R_OK);
    return { path, format };
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError("source-unavailable");
  }
}

async function runChild(
  argv: readonly string[],
  workspace: string,
  timeoutMs: number,
  failureCode: "extraction-failed" | "polish-failed",
): Promise<void> {
  let child: Bun.Subprocess | undefined;
  let timedOut = false;
  let cancelled = false;
  const kill = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // The awaited exit status remains authoritative.
    }
  };
  const cancel = () => {
    cancelled = true;
    kill();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    try {
      child = Bun.spawn([...argv], {
        cwd: workspace,
        env: childEnvironment(workspace),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      throw new MaintenanceError("backend-unavailable");
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref();
    const exitCode = await child.exited;
    clearTimeout(timer);
    if (cancelled) throw new MaintenanceError("maintenance-cancelled");
    if (timedOut) throw new MaintenanceError("maintenance-timeout");
    if (exitCode !== 0) throw new MaintenanceError(failureCode);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (child && child.exitCode === null) {
      kill();
      await child.exited.catch(() => undefined);
    }
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  let file;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
      throw new MaintenanceError("artifact-invalid");
    }
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await readFile(file);
    if (bytes.byteLength !== metadata.size) throw new MaintenanceError("artifact-invalid");
    return bytes;
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError("artifact-invalid");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export async function extractEbookText(options: {
  readonly backendPath: string;
  readonly sourcePath: string;
  readonly timeoutMs: number;
}): Promise<{ readonly sourcePath: string; readonly format: FormatId; readonly text: string }> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new MaintenanceError("invalid-arguments");
  }
  const [backendPath, source] = await Promise.all([
    executable(options.backendPath),
    sourceFile(options.sourcePath),
  ]);
  if (!backendPath) throw new MaintenanceError("backend-unavailable");
  if (!TEXT_EXTRACTABLE_FORMATS.includes(source.format)) {
    throw new MaintenanceError("unsupported-format");
  }
  if (source.format === "txt") {
    const bytes = await readBoundedRegularFile(source.path, MAX_TEXT_BYTES);
    return { sourcePath: source.path, format: source.format, text: bytes.toString("utf8") };
  }

  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-text-"));
    await chmod(workspace, 0o700);
    const output = join(workspace, "content.txt");
    await runChild(
      [backendPath, source.path, output, "--txt-output-formatting=plain"],
      workspace,
      options.timeoutMs,
      "extraction-failed",
    );
    const bytes = await readBoundedRegularFile(output, MAX_TEXT_BYTES);
    return { sourcePath: source.path, format: source.format, text: bytes.toString("utf8") };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function findLiteralText(
  text: string,
  query: string,
  maxSnippets = 3,
): { readonly matches: number; readonly snippets: readonly string[] } {
  if (!query || !Number.isSafeInteger(maxSnippets) || maxSnippets < 1) {
    throw new MaintenanceError("invalid-arguments");
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const snippets: string[] = [];
  let matches = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    matches += 1;
    if (snippets.length < maxSnippets) {
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + query.length + 80);
      snippets.push(text.slice(start, end).replace(/\s+/g, " ").trim());
    }
    offset = index + needle.length;
  }
  return { matches, snippets };
}

async function hashArtifact(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 ||
    metadata.size > MAX_ARTIFACT_BYTES
  ) {
    throw new MaintenanceError("artifact-invalid");
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of file.readableWebStream()) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) throw new MaintenanceError("artifact-invalid");
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  if (bytes !== metadata.size) throw new MaintenanceError("artifact-invalid");
  return { bytes, sha256: hash.digest("hex") };
}

const polishFlags: Readonly<Record<PolishOperation, string>> = {
  "embed-fonts": "--embed-fonts",
  "subset-fonts": "--subset-fonts",
  "smarten-punctuation": "--smarten-punctuation",
  "remove-unused-css": "--remove-unused-css",
  "compress-images": "--compress-images",
  "add-soft-hyphens": "--add-soft-hyphens",
  "remove-soft-hyphens": "--remove-soft-hyphens",
  "upgrade-book": "--upgrade-book",
};

export async function polishEbook(options: {
  readonly backendPath: string;
  readonly input: string;
  readonly output: string;
  readonly operations: readonly PolishOperation[];
  readonly timeoutMs: number;
}): Promise<{
  readonly backend: "ebook-polish";
  readonly inputFormat: "kepub" | "epub" | "azw3";
  readonly operations: readonly PolishOperation[];
  readonly artifact: { readonly path: string; readonly bytes: number; readonly sha256: string };
}> {
  if (
    !options.output || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
    options.operations.length < 1 || new Set(options.operations).size !== options.operations.length ||
    options.operations.some((operation) => !POLISH_OPERATIONS.includes(operation)) ||
    (options.operations.includes("add-soft-hyphens") &&
      options.operations.includes("remove-soft-hyphens"))
  ) {
    throw new MaintenanceError("invalid-arguments");
  }
  const [backendPath, source] = await Promise.all([
    executable(options.backendPath),
    sourceFile(options.input),
  ]);
  if (!backendPath) throw new MaintenanceError("backend-unavailable");
  if (source.format !== "kepub" && source.format !== "epub" && source.format !== "azw3") {
    throw new MaintenanceError("unsupported-format");
  }

  const requestedOutput = resolve(options.output);
  if (detectFormat(requestedOutput) !== source.format) {
    throw new MaintenanceError("invalid-arguments");
  }
  let outputPath = requestedOutput;
  try {
    const parent = await realpath(dirname(requestedOutput));
    if (!(await stat(parent)).isDirectory()) throw new Error("not a directory");
    outputPath = join(parent, basename(requestedOutput));
    await lstat(outputPath);
    throw new MaintenanceError("output-file-exists");
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MaintenanceError("invalid-arguments");
    }
  }

  let workspace: string | undefined;
  let partialPath: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-polish-"));
    await chmod(workspace, 0o700);
    const artifactPath = join(workspace, `polished.${source.format}`);
    await runChild(
      [backendPath, ...options.operations.map((operation) => polishFlags[operation]), source.path, artifactPath],
      workspace,
      options.timeoutMs,
      "polish-failed",
    );
    await hashArtifact(artifactPath);
    partialPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
    try {
      await copyFile(artifactPath, partialPath, constants.COPYFILE_EXCL);
      const artifact = await hashArtifact(partialPath);
      await link(partialPath, outputPath);
      return {
        backend: "ebook-polish",
        inputFormat: source.format,
        operations: [...options.operations],
        artifact: { path: outputPath, ...artifact },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MaintenanceError("output-file-exists");
      }
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError("copy-failed");
    }
  } finally {
    if (partialPath) await rm(partialPath, { force: true }).catch(() => undefined);
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
