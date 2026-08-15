import {
  FORMAT_CATALOG,
  FORMAT_IDS,
  PlanningError,
  planConversion,
  type ConversionCapability,
  type ConversionProfileId,
  type FormatId,
} from "@takio/core";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  link,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAX_ARTIFACT_BYTES = 4 * 1024 ** 3;
const MACOS_BUNDLE_BINARY = "/Applications/calibre.app/Contents/MacOS/ebook-convert";

export const NATIVE_CONVERSION_CAPABILITIES: readonly ConversionCapability[] = [
  { from: "epub", to: "kepub" },
];

export const CALIBRE_CONVERSION_CAPABILITIES: readonly ConversionCapability[] = [
  { from: "epub", to: "pdf" },
  { from: "epub", to: "azw3" },
  { from: "docx", to: "epub" },
  { from: "html", to: "epub" },
  { from: "txt", to: "epub" },
];

export const LOCAL_CONVERSION_CAPABILITIES: readonly ConversionCapability[] = [
  ...NATIVE_CONVERSION_CAPABILITIES,
  ...CALIBRE_CONVERSION_CAPABILITIES,
];

const CONVERSION_ERROR_CODES = [
  "invalid-arguments",
  "backend-unavailable",
  "source-unavailable",
  "unsupported-conversion",
  "output-file-exists",
  "conversion-failed",
  "conversion-timeout",
  "conversion-cancelled",
  "artifact-invalid",
  "copy-failed",
] as const;

type ConversionErrorCode = (typeof CONVERSION_ERROR_CODES)[number];

export class ConversionError extends Error {
  constructor(readonly code: ConversionErrorCode) {
    super(code);
    this.name = "ConversionError";
  }
}

export type EbookConvertDiscovery =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "invalid-arguments" | "backend-unavailable" };

async function executable(path: string): Promise<string | null> {
  try {
    const canonicalPath = await realpath(resolve(path));
    if (!(await stat(canonicalPath)).isFile()) {
      return null;
    }
    await access(canonicalPath, constants.X_OK);
    return canonicalPath;
  } catch {
    return null;
  }
}

export async function discoverEbookConvert(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  macosBundleBinary: string = MACOS_BUNDLE_BINARY,
): Promise<EbookConvertDiscovery> {
  if (Object.hasOwn(env, "TAKIO_EBOOK_CONVERT")) {
    const override = env.TAKIO_EBOOK_CONVERT;
    if (override === "" || override === undefined) {
      return { ok: false, code: "invalid-arguments" };
    }
    const path = await executable(override);
    return path
      ? { ok: true, path }
      : { ok: false, code: "backend-unavailable" };
  }

  let fromPath: string | null = null;
  try {
    fromPath = Bun.which("ebook-convert", { PATH: env.PATH });
  } catch {
    // An unusable search path is the same as a backend discovery miss.
  }
  if (fromPath) {
    const path = await executable(fromPath);
    if (path) {
      return { ok: true, path };
    }
  }

  if (platform === "darwin") {
    const path = await executable(macosBundleBinary);
    if (path) {
      return { ok: true, path };
    }
  }

  return { ok: false, code: "backend-unavailable" };
}

type ConvertLocalOptions = {
  readonly backendPath?: string;
  readonly input: string;
  readonly output: string;
  readonly outputFormat: string;
  readonly profileId?: ConversionProfileId;
  readonly timeoutMs: number;
};

type ConversionArtifact = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

type CompletedConversionJob = {
  readonly id: string;
  readonly backend: "ebook-convert" | "takio-epub";
  readonly inputFormat: FormatId;
  readonly outputFormat: FormatId;
  readonly profileId: ConversionProfileId;
  readonly status: "completed";
  readonly artifact: ConversionArtifact;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function sourceFile(input: string): Promise<string> {
  if (input === "") {
    throw new ConversionError("invalid-arguments");
  }
  try {
    const path = await realpath(resolve(input));
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      throw new ConversionError("source-unavailable");
    }
    if (metadata.size === 0) {
      throw new ConversionError("invalid-arguments");
    }
    await access(path, constants.R_OK);
    return path;
  } catch (error) {
    if (error instanceof ConversionError) {
      throw error;
    }
    throw new ConversionError("source-unavailable");
  }
}

async function outputFile(output: string, outputFormat: FormatId): Promise<string> {
  if (output === "") {
    throw new ConversionError("invalid-arguments");
  }
  const definition = FORMAT_CATALOG.find((format) => format.id === outputFormat)!;
  const requested = resolve(output);
  if (!definition.extensions.some((extension) => requested.toLowerCase().endsWith(extension))) {
    throw new ConversionError("invalid-arguments");
  }

  try {
    const parent = await realpath(dirname(requested));
    if (!(await stat(parent)).isDirectory()) {
      throw new Error("output parent is not a directory");
    }
    const path = join(parent, basename(requested));
    if (await pathExists(path)) {
      throw new ConversionError("output-file-exists");
    }
    return path;
  } catch (error) {
    if (error instanceof ConversionError) {
      throw error;
    }
    throw new ConversionError("invalid-arguments");
  }
}

function validatedPlan(
  input: string,
  outputFormat: string,
  profileId: ConversionProfileId,
) {
  if (!FORMAT_IDS.includes(outputFormat as FormatId)) {
    throw new ConversionError("invalid-arguments");
  }
  try {
    return planConversion({
      input,
      outputFormat: outputFormat as FormatId,
      targets: [{
        id: "local",
        name: "This Mac",
        capabilities: [...LOCAL_CONVERSION_CAPABILITIES],
        status: "online",
      }],
      settings: { version: 1, profileId },
    });
  } catch (error) {
    if (error instanceof PlanningError) {
      throw new ConversionError("unsupported-conversion");
    }
    throw error;
  }
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
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  environment.TMPDIR = workspace;
  environment.TMP = workspace;
  environment.TEMP = workspace;
  return environment;
}

function nativeKepubCommand(input: string, output: string): string[] {
  const executable = process.execPath;
  const entrypoint = process.argv[1];
  return /(?:^|\/)bun(?:\.exe)?$/i.test(executable) && entrypoint
    ? [executable, entrypoint, "__native-kepub", input, output]
    : [executable, "__native-kepub", input, output];
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function copyArtifact(
  artifactPath: string,
  partialPath: string,
): Promise<{ bytes: number; sha256: string }> {
  let source;
  try {
    source = await open(
      artifactPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new ConversionError("artifact-invalid");
  }

  try {
    const initialMetadata = await source.stat();
    if (
      !initialMetadata.isFile() ||
      initialMetadata.size === 0 ||
      initialMetadata.size > MAX_ARTIFACT_BYTES
    ) {
      throw new ConversionError("artifact-invalid");
    }

    let destination;
    try {
      destination = await open(
        partialPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch {
      throw new ConversionError("copy-failed");
    }

    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          break;
        }
        bytes += bytesRead;
        if (bytes > MAX_ARTIFACT_BYTES) {
          throw new ConversionError("artifact-invalid");
        }
        hash.update(buffer.subarray(0, bytesRead));

        let bytesWritten = 0;
        while (bytesWritten < bytesRead) {
          const result = await destination.write(
            buffer,
            bytesWritten,
            bytesRead - bytesWritten,
          );
          if (result.bytesWritten === 0) {
            throw new ConversionError("copy-failed");
          }
          bytesWritten += result.bytesWritten;
        }
      }

      const [finalSourceMetadata, destinationMetadata] = await Promise.all([
        source.stat(),
        destination.stat(),
      ]);
      if (
        bytes === 0 ||
        bytes !== initialMetadata.size ||
        bytes !== finalSourceMetadata.size ||
        bytes !== destinationMetadata.size
      ) {
        throw new ConversionError("artifact-invalid");
      }
      await destination.sync();
      return { bytes, sha256: hash.digest("hex") };
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

export async function convertLocal({
  backendPath,
  input,
  output,
  outputFormat,
  profileId = "default",
  timeoutMs,
}: ConvertLocalOptions): Promise<CompletedConversionJob> {
  if (
    input === "" ||
    output === "" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new ConversionError("invalid-arguments");
  }

  const plan = validatedPlan(input, outputFormat, profileId);
  const nativeKepub = plan.inputFormat === "epub" && plan.outputFormat === "kepub";
  const [canonicalBackendPath, canonicalInput] = await Promise.all([
    backendPath ? executable(backendPath) : Promise.resolve(null),
    sourceFile(input),
  ]);
  if (!nativeKepub && !canonicalBackendPath) {
    throw new ConversionError("backend-unavailable");
  }
  const finalPath = await outputFile(output, plan.outputFormat);

  let workspace: string | undefined;
  let partialPath: string | undefined;
  let child: Bun.Subprocess | undefined;
  let timedOut = false;
  let cancelled = false;
  let publicationStarted = false;
  const killChild = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      // Cleanup remains best-effort; the awaited child status is authoritative.
    }
  };
  const cancel = () => {
    if (publicationStarted) {
      return;
    }
    cancelled = true;
    killChild();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-convert-"));
    await chmod(workspace, 0o700);
    const artifactPath = join(workspace, `output.${plan.outputFormat}`);
    if (cancelled) {
      throw new ConversionError("conversion-cancelled");
    }

    if (nativeKepub) {
      try {
        child = Bun.spawn(nativeKepubCommand(canonicalInput, artifactPath), {
          cwd: workspace,
          env: childEnvironment(workspace),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        throw new ConversionError("backend-unavailable");
      }
    } else {
      try {
        child = Bun.spawn([
          canonicalBackendPath!,
          canonicalInput,
          artifactPath,
          ...(profileId === "default" ? [] : ["--output-profile", profileId]),
        ], {
          cwd: workspace,
          env: childEnvironment(workspace),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        throw new ConversionError("backend-unavailable");
      }
    }
    if (cancelled) killChild();

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timer.unref();
    const exitCode = await child.exited;
    clearTimeout(timer);
    if (!cancelled && !timedOut && exitCode !== 0) {
      throw new ConversionError("conversion-failed");
    }

    if (cancelled) {
      throw new ConversionError("conversion-cancelled");
    }
    if (timedOut) {
      throw new ConversionError("conversion-timeout");
    }
    partialPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
    try {
      const verified = await copyArtifact(artifactPath, partialPath);
      if (cancelled) {
        throw new ConversionError("conversion-cancelled");
      }
      await syncDirectory(dirname(finalPath));
      if (cancelled) {
        throw new ConversionError("conversion-cancelled");
      }
      publicationStarted = true;
      await link(partialPath, finalPath);
      // The no-clobber link is the commit point. Durability and private-name
      // cleanup are best-effort after publication so success is never reported
      // as failure while leaving the requested output in place.
      await syncDirectory(dirname(finalPath)).catch(() => {});
      return {
        id: plan.id,
        backend: nativeKepub ? "takio-epub" : "ebook-convert",
        inputFormat: plan.inputFormat,
        outputFormat: plan.outputFormat,
        profileId,
        status: "completed",
        artifact: { path: finalPath, ...verified },
      };
    } catch (error) {
      if (error instanceof ConversionError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConversionError("output-file-exists");
      }
      throw new ConversionError("copy-failed");
    }
  } catch (error) {
    if (error instanceof ConversionError) {
      throw error;
    }
    throw new ConversionError("copy-failed");
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (child && child.exitCode === null) {
      killChild();
      await child.exited.catch(() => {});
    }
    if (partialPath) {
      await rm(partialPath, { force: true }).catch(() => {});
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
