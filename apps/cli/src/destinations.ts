import {
  classifyDestinationKind,
  defaultDestinationSubdir,
  sanitizeDestinationFileName,
  type Destination,
} from "@takio/core";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { destinationTestSeam } from "./destination-test-seam.js";

export const DESTINATION_TRANSFER_ERROR_CODES = [
  "source-unavailable",
  "invalid-arguments",
  "destination-file-exists",
  "verification-failed",
  "copy-failed",
] as const;

export type DestinationTransferErrorCode =
  (typeof DESTINATION_TRANSFER_ERROR_CODES)[number];

export class DestinationTransferError extends Error {
  constructor(readonly code: DestinationTransferErrorCode) {
    super(code);
    this.name = "DestinationTransferError";
  }
}

export interface SendToDestinationOptions {
  readonly itemId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly destination: Destination;
  readonly subdir?: string;
  readonly overwrite?: boolean;
}

export interface SendToDestinationResult {
  readonly itemId: string;
  readonly destinationId: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DestinationManifestRecord {
  readonly itemId: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: string;
  readonly timestamp: string;
}

export interface DestinationInventoryEntry extends DestinationManifestRecord {
  readonly status: "present" | "missing" | "changed";
}

const MANIFEST_VERSION = 1;
const MANIFEST_DIRECTORY = ".takio";
const MANIFEST_FILE = "deliveries.json";

export type DestinationCommandRunner = (
  argv: readonly string[],
) => Promise<number>;

async function runDestinationCommand(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited;
}

export async function ejectDestination(
  destinationPath: string,
  run: DestinationCommandRunner = runDestinationCommand,
): Promise<number> {
  return run(["diskutil", "eject", destinationPath]);
}

export async function listDestinations(
  volumesRoot: string,
): Promise<readonly Destination[]> {
  const entries = await readdir(volumesRoot);
  const destinations: Destination[] = [];

  for (const name of entries) {
    const candidatePath = join(volumesRoot, name);

    try {
      const canonicalPath = await realpath(candidatePath);
      if (canonicalPath === "/" || !(await stat(canonicalPath)).isDirectory()) {
        continue;
      }

      const rootEntries = await readdir(canonicalPath);
      let freeBytes: number | undefined;
      try {
        const filesystem = await statfs(canonicalPath);
        freeBytes = filesystem.bavail * filesystem.bsize;
      } catch {
        // Capacity is optional when a mounted filesystem does not expose it.
      }

      destinations.push({
        id: name,
        name,
        path: canonicalPath,
        kind: classifyDestinationKind(rootEntries),
        ...(rootEntries.some((entry) => entry.toLowerCase() === "koreader")
          ? { features: ["koreader"] as const }
          : {}),
        ...(freeBytes === undefined ? {} : { freeBytes }),
      });
    } catch {
      // A stale, unreadable, or non-directory volume entry is not a destination.
    }
  }

  return destinations.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

export async function authorizeDestination(
  destinationPath: string,
  volumesRoot: string,
): Promise<Destination | null> {
  try {
    const canonicalPath = await realpath(destinationPath);
    const destinations = await listDestinations(volumesRoot);
    return (
      destinations.find((destination) => destination.path === canonicalPath) ?? null
    );
  } catch {
    return null;
  }
}

function isContained(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function sourceFile(sourcePath: string): Promise<string> {
  try {
    const canonicalPath = await realpath(resolve(sourcePath));
    if (!(await stat(canonicalPath)).isFile()) {
      throw new Error("Source is not a file.");
    }
    await access(canonicalPath, constants.R_OK);
    return canonicalPath;
  } catch {
    throw new DestinationTransferError("source-unavailable");
  }
}

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

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function manifestPath(destination: Destination): string {
  return join(destination.path, MANIFEST_DIRECTORY, MANIFEST_FILE);
}

function relativeDestinationPath(destination: Destination, path: string): string {
  const absolutePath = resolve(path);
  if (!isContained(destination.path, absolutePath)) {
    throw new DestinationTransferError("invalid-arguments");
  }
  const relativePath = relative(destination.path, absolutePath).split(sep).join("/");
  if (relativePath === "" || relativePath.startsWith("../") || relativePath === "..") {
    throw new DestinationTransferError("invalid-arguments");
  }
  return relativePath;
}

export function destinationDeliveryRelativePath(destination: Destination, path: string): string {
  return relativeDestinationPath(destination, path);
}

async function readManifest(destination: Destination): Promise<DestinationManifestRecord[]> {
  try {
    const raw = await Bun.file(manifestPath(destination)).text();
    const parsed = JSON.parse(raw) as { version?: unknown; deliveries?: unknown };
    if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.deliveries)) return [];
    return parsed.deliveries.filter((record): record is DestinationManifestRecord => {
      const candidate = record as Partial<DestinationManifestRecord>;
      return typeof candidate.itemId === "string" && typeof candidate.relativePath === "string" &&
        typeof candidate.bytes === "number" && typeof candidate.sha256 === "string" &&
        typeof candidate.format === "string" && typeof candidate.timestamp === "string" &&
        !candidate.relativePath.startsWith("/") && !candidate.relativePath.split("/").includes("..");
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new DestinationTransferError("copy-failed");
  }
}

async function writeManifest(destination: Destination, deliveries: readonly DestinationManifestRecord[]): Promise<void> {
  const directory = join(destination.path, MANIFEST_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const path = manifestPath(destination);
  const temporary = join(directory, `.deliveries-${randomUUID()}.json.tmp`);
  const body = JSON.stringify({ version: MANIFEST_VERSION, deliveries }, null, 2);
  await writeFile(temporary, body, { flag: "wx" });
  await syncFile(temporary);
  await rm(path, { force: true }).catch(() => {});
  await rename(temporary, path);
  await syncDirectory(directory).catch(() => {});
}

export async function recordDestinationDelivery(
  destination: Destination,
  delivery: Omit<DestinationManifestRecord, "timestamp"> & { readonly timestamp?: string },
): Promise<DestinationManifestRecord> {
  const deliveries = await readManifest(destination);
  const record = {
    ...delivery,
    relativePath: relativeDestinationPath(destination, resolve(destination.path, delivery.relativePath)),
    timestamp: delivery.timestamp ?? new Date().toISOString(),
  };
  await writeManifest(destination, [
    ...deliveries.filter((candidate) => candidate.itemId !== record.itemId),
    record,
  ].sort((left, right) => left.itemId.localeCompare(right.itemId)));
  return record;
}

export async function inventoryDestination(destination: Destination): Promise<DestinationInventoryEntry[]> {
  const deliveries = await readManifest(destination);
  const entries: DestinationInventoryEntry[] = [];
  for (const record of deliveries) {
    const path = resolve(destination.path, record.relativePath);
    if (!isContained(destination.path, path)) continue;
    try {
      const actual = await hashFile(path);
      entries.push({ ...record, status: actual.bytes === record.bytes && actual.sha256 === record.sha256 ? "present" : "changed" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push({ ...record, status: "missing" });
      else throw new DestinationTransferError("copy-failed");
    }
  }
  return entries;
}

export async function removeDestinationDelivery(destination: Destination, itemId: string): Promise<DestinationManifestRecord> {
  const deliveries = await readManifest(destination);
  const record = deliveries.find((candidate) => candidate.itemId === itemId);
  if (!record || record.relativePath.startsWith("/") || record.relativePath.split("/").includes("..")) {
    throw new DestinationTransferError("invalid-arguments");
  }
  const path = resolve(destination.path, record.relativePath);
  if (!isContained(destination.path, path)) throw new DestinationTransferError("invalid-arguments");
  try {
    const actual = await hashFile(path);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      throw new DestinationTransferError("verification-failed");
    }
    await rm(path);
  } catch (error) {
    if (error instanceof DestinationTransferError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DestinationTransferError("copy-failed");
  }
  await writeManifest(destination, deliveries.filter((candidate) => candidate.itemId !== itemId));
  return record;
}

export async function sendToDestination({
  itemId,
  sourcePath,
  fileName: requestedFileName,
  destination,
  subdir,
  overwrite = false,
}: SendToDestinationOptions): Promise<SendToDestinationResult> {
  const canonicalSourcePath = await sourceFile(sourcePath);
  const requestedSubdir = subdir ?? defaultDestinationSubdir(destination.kind);
  const unresolvedTargetDirectory = resolve(destination.path, requestedSubdir);
  if (
    isAbsolute(requestedSubdir) ||
    !isContained(destination.path, unresolvedTargetDirectory)
  ) {
    throw new DestinationTransferError("invalid-arguments");
  }

  let targetDirectory: string;
  try {
    await mkdir(unresolvedTargetDirectory, { recursive: true });
    targetDirectory = await realpath(unresolvedTargetDirectory);
  } catch {
    throw new DestinationTransferError("copy-failed");
  }
  if (!isContained(destination.path, targetDirectory)) {
    throw new DestinationTransferError("invalid-arguments");
  }

  const sourceName = requestedFileName ?? basename(canonicalSourcePath);
  const extension = extname(sourceName).slice(1);
  const fileName =
    sanitizeDestinationFileName(sourceName) ??
    sanitizeDestinationFileName(`${itemId}.${extension}`) ??
    "item";
  const finalPath = join(targetDirectory, fileName);
  try {
    if (!overwrite && (await pathExists(finalPath))) {
      throw new DestinationTransferError("destination-file-exists");
    }
  } catch (error) {
    if (error instanceof DestinationTransferError) {
      throw error;
    }
    throw new DestinationTransferError("copy-failed");
  }

  const partialPath = join(targetDirectory, `.takio-partial-${randomUUID()}`);
  let published = false;
  try {
    const sourceHash = createHash("sha256");
    let sourceBytes = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sourceHash.update(chunk);
        sourceBytes += chunk.byteLength;
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(canonicalSourcePath),
      hasher,
      createWriteStream(partialPath, { flags: "wx" }),
    );
    await syncFile(partialPath);
    await destinationTestSeam.afterPartialWrite?.(partialPath);

    const sourceSha256 = sourceHash.digest("hex");
    const verified = await hashFile(partialPath);
    if (verified.bytes !== sourceBytes || verified.sha256 !== sourceSha256) {
      throw new DestinationTransferError("verification-failed");
    }

    if (overwrite) {
      await rename(partialPath, finalPath);
    } else {
      try {
        await copyFile(partialPath, finalPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DestinationTransferError("destination-file-exists");
        }
        throw error;
      }
      await syncFile(finalPath);
      const publishedHash = await hashFile(finalPath);
      if (
        publishedHash.bytes !== sourceBytes ||
        publishedHash.sha256 !== sourceSha256
      ) {
        await rm(finalPath, { force: true }).catch(() => {});
        throw new DestinationTransferError("verification-failed");
      }
      await rm(partialPath, { force: true }).catch(() => {});
    }
    published = true;
    await syncDirectory(targetDirectory);
    const result = {
      itemId,
      destinationId: destination.id,
      path: finalPath,
      bytes: sourceBytes,
      sha256: sourceSha256,
    };
    return result;
  } catch (error) {
    if (error instanceof DestinationTransferError) {
      throw error;
    }
    throw new DestinationTransferError("copy-failed");
  } finally {
    if (!published) {
      await rm(partialPath, { force: true }).catch(() => {});
    }
  }
}
