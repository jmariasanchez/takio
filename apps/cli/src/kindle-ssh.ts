import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, posix, resolve } from "node:path";
import { constants } from "node:fs";
import { sanitizeDestinationFileName } from "@takio/core";
import { DestinationTransferError } from "./destinations.js";

export type KindleSshRunner = (
  argv: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<{ readonly exitCode: number; readonly stdout?: string }>;

export interface KindleSshDestination {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly remoteRoot: string;
  readonly identityFile?: string;
  readonly strictHostKeyChecking?: boolean;
  readonly timeoutMs?: number;
}

export interface SendToKindleSshOptions {
  readonly itemId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly destination: KindleSshDestination;
  readonly runner?: KindleSshRunner;
}

export interface SendToKindleSshResult {
  readonly itemId: string;
  readonly transport: "kindle-ssh";
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly verification: "sha256" | "size";
}

const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\[(?:[0-9A-Fa-f:.]+)\]$/;
const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

async function defaultRunner(argv: readonly string[], { timeoutMs }: { timeoutMs: number }) {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { exitCode, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

function rejectControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function validateKindleSshDestination(destination: KindleSshDestination): KindleSshDestination {
  if (!HOST_PATTERN.test(destination.host) || rejectControl(destination.host) || destination.host.startsWith("-")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  if (!USER_PATTERN.test(destination.user) || destination.user.startsWith("-")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  if (!Number.isSafeInteger(destination.port) || destination.port < 1 || destination.port > 65_535) {
    throw new DestinationTransferError("invalid-arguments");
  }
  if (destination.identityFile !== undefined) {
    if (!isAbsolute(destination.identityFile) || rejectControl(destination.identityFile) || basename(destination.identityFile).startsWith("-")) {
      throw new DestinationTransferError("invalid-arguments");
    }
  }
  const root = destination.remoteRoot;
  if (!root.startsWith("/mnt/us/") || root !== posix.normalize(root) || root.includes("//") || root.split("/").includes("..")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  if (!root.toLowerCase().includes("/documents") && !root.toLowerCase().includes("/koreader")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  for (const segment of root.split("/").filter(Boolean)) {
    if (!REMOTE_SEGMENT_PATTERN.test(segment)) throw new DestinationTransferError("invalid-arguments");
  }
  const timeoutMs = destination.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new DestinationTransferError("invalid-arguments");
  }
  return { ...destination, strictHostKeyChecking: destination.strictHostKeyChecking ?? true, timeoutMs };
}

function sshBase(destination: KindleSshDestination): string[] {
  const args = ["-p", String(destination.port), "-o", `StrictHostKeyChecking=${destination.strictHostKeyChecking === false ? "accept-new" : "yes"}`, "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no"];
  if (destination.identityFile) args.push("-i", destination.identityFile);
  return args;
}

async function sourceHash(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function runChecked(runner: KindleSshRunner, argv: readonly string[], timeoutMs: number, code: "copy-failed" | "destination-file-exists" | "verification-failed") {
  const result = await runner(argv, { timeoutMs });
  if (result.exitCode !== 0) throw new DestinationTransferError(code);
  return result.stdout ?? "";
}

export async function sendToKindleSsh({ itemId, sourcePath, fileName, destination: rawDestination, runner = defaultRunner }: SendToKindleSshOptions): Promise<SendToKindleSshResult> {
  const destination = validateKindleSshDestination(rawDestination);
  const canonicalSource = resolve(sourcePath);
  try {
    if (!(await stat(canonicalSource)).isFile()) throw new Error("not file");
    await access(canonicalSource, constants.R_OK);
  } catch {
    throw new DestinationTransferError("source-unavailable");
  }
  const sourceName = fileName ?? basename(canonicalSource);
  const extension = extname(sourceName).slice(1);
  const safeName = sanitizeDestinationFileName(sourceName) ?? sanitizeDestinationFileName(`${itemId}.${extension}`) ?? "item";
  if (!REMOTE_SEGMENT_PATTERN.test(safeName) || safeName.startsWith("-")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  const remoteFinal = posix.join(destination.remoteRoot, safeName);
  const remotePartial = posix.join(destination.remoteRoot, `.takio-partial-${randomUUID()}`);
  const target = `${destination.user}@${destination.host}`;
  const timeoutMs = destination.timeoutMs!;
  const ssh = ["ssh", ...sshBase(destination), target];
  const scp = ["scp", "-P", String(destination.port), "-o", `StrictHostKeyChecking=${destination.strictHostKeyChecking === false ? "accept-new" : "yes"}`, "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", ...(destination.identityFile ? ["-i", destination.identityFile] : [])];
  const expected = await sourceHash(canonicalSource);
  try {
    await runChecked(runner, [...ssh, "test", "-d", destination.remoteRoot], timeoutMs, "copy-failed");
    const exists = await runner([...ssh, "test", "!", "-e", remoteFinal], { timeoutMs });
    if (exists.exitCode !== 0) throw new DestinationTransferError("destination-file-exists");
    await runChecked(runner, [...scp, canonicalSource, `${target}:${remotePartial}`], timeoutMs, "copy-failed");
    const hashOut = await runner([...ssh, "sha256sum", remotePartial], { timeoutMs });
    let verification: "sha256" | "size" = "size";
    if (hashOut.exitCode === 0 && (hashOut.stdout ?? "").trim().startsWith(expected.sha256)) {
      verification = "sha256";
    } else {
      const size = (await runChecked(runner, [...ssh, "wc", "-c", remotePartial], timeoutMs, "verification-failed")).trim().split(/\s+/)[0];
      if (size !== String(expected.bytes)) throw new DestinationTransferError("verification-failed");
    }
    await runChecked(runner, [...ssh, "ln", remotePartial, remoteFinal], timeoutMs, "destination-file-exists");
    await runner([...ssh, "rm", "-f", remotePartial], { timeoutMs });
    return { itemId, transport: "kindle-ssh", path: remoteFinal, bytes: expected.bytes, sha256: expected.sha256, verification };
  } catch (error) {
    await runner([...ssh, "rm", "-f", remotePartial], { timeoutMs }).catch(() => {});
    if (error instanceof DestinationTransferError) throw error;
    throw new DestinationTransferError("copy-failed");
  }
}
