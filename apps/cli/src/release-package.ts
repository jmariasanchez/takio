import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export class ReleasePackageError extends Error {
  constructor(readonly code: "invalid-arguments" | "source-unavailable" | "output-file-exists" | "write-failed") {
    super(code);
  }
}

export function releaseArtifactName(version: string, platform: NodeJS.Platform, arch: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleasePackageError("invalid-arguments");
  }
  const platformName = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
  if (!platformName || !architecture) throw new ReleasePackageError("invalid-arguments");
  return `takio-v${version}-${platformName}-${architecture}`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function packageCliRelease(options: {
  readonly sourcePath: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): Promise<{ readonly artifactPath: string; readonly checksumPath: string; readonly bytes: number; readonly sha256: string }> {
  let sourcePath: string;
  try {
    sourcePath = await realpath(resolve(options.sourcePath));
    const source = await stat(sourcePath);
    if (!source.isFile() || source.size === 0) throw new Error();
  } catch {
    throw new ReleasePackageError("source-unavailable");
  }

  let outputDirectory: string;
  try {
    await mkdir(resolve(options.outputDirectory), { recursive: true });
    outputDirectory = await realpath(resolve(options.outputDirectory));
  } catch {
    throw new ReleasePackageError("write-failed");
  }

  const artifactName = releaseArtifactName(
    options.version,
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  );
  const artifactPath = join(outputDirectory, artifactName);
  const checksumPath = `${artifactPath}.sha256`;
  let artifactCreated = false;
  let checksumCreated = false;
  try {
    await copyFile(sourcePath, artifactPath, constants.COPYFILE_EXCL);
    artifactCreated = true;
    await chmod(artifactPath, 0o755);
    const artifact = await open(artifactPath, "r");
    await artifact.sync();
    await artifact.close();
    const metadata = await stat(artifactPath);
    const digest = await sha256(artifactPath);
    const checksum = await open(checksumPath, "wx", 0o600);
    checksumCreated = true;
    await checksum.writeFile(`${digest}  ${basename(artifactPath)}\n`);
    await checksum.sync();
    await checksum.close();
    return { artifactPath, checksumPath, bytes: metadata.size, sha256: digest };
  } catch (error) {
    if (artifactCreated) await rm(artifactPath, { force: true }).catch(() => {});
    if (checksumCreated) await rm(checksumPath, { force: true }).catch(() => {});
    throw new ReleasePackageError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "output-file-exists" : "write-failed",
    );
  }
}
