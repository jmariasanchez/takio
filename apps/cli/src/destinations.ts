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
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
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

export async function sendToDestination({
  itemId,
  sourcePath,
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

  const sourceName = basename(canonicalSourcePath);
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
  let renamed = false;
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

    if (!overwrite && (await pathExists(finalPath))) {
      throw new DestinationTransferError("destination-file-exists");
    }

    await rename(partialPath, finalPath);
    renamed = true;
    await syncDirectory(targetDirectory);
    return {
      itemId,
      destinationId: destination.id,
      path: finalPath,
      bytes: sourceBytes,
      sha256: sourceSha256,
    };
  } catch (error) {
    if (error instanceof DestinationTransferError) {
      throw error;
    }
    throw new DestinationTransferError("copy-failed");
  } finally {
    if (!renamed) {
      await rm(partialPath, { force: true }).catch(() => {});
    }
  }
}
